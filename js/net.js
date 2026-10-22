/**
 * TANK 2026 - Online Play (PeerJS / WebRTC)
 * The host runs the full simulation as Player I and streams state snapshots
 * to every guest; each guest drives one tank and only renders what the host sends.
 */

const NET_PREFIX = 'tank2026-room-';
const NET_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NET_TIMEOUT_MS = 8000;

// Sounds and visual effects triggered by the host simulation are replayed on the guests
const NET_SOUNDS = ['playShoot', 'playHitSteel', 'playHitBrick', 'playExplosion', 'playPowerUpSpawn', 'playPowerUpCollect', 'playBonusAlert', 'playRicochet'];
const NET_FX = ['spawnBrickDebris', 'spawnRicochetSparks', 'spawnTankDebris', 'spawnMuzzleSparks', 'spawnSparkles', 'spawnSmokePuff', 'spawnRing', 'flashScreen', 'spawnLeafBurst'];

class NetSession {
  // maxGuests: how many guests the host accepts (1 classic, 3 on the big map)
  constructor(game, isHost, maxGuests = 1) {
    this.game = game;
    this.isHost = isHost;
    this.isGuest = !isHost;
    this.maxGuests = maxGuests;
    this.peer = null;
    this.peers = [];      // Open connections: { conn, slot, name, lastRecv, lastMap }
    this.locked = false;  // Host: game started, no new players
    this.closed = false;
    this.pingTimer = null;
    this.joinTimer = null;

    // Host: outgoing effects & UI events for the next frame
    this.events = [];
    this.ui = [];

    // Guest: input state
    this.taps = 0;
    this.lastInput = '';
    this.inputTimer = 0;
  }

  get connected() {
    return !this.closed && this.peers.length > 0;
  }

  static makeCode() {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += NET_CODE_CHARS[Math.floor(Math.random() * NET_CODE_CHARS.length)];
    }
    return code;
  }

  host(onCode, onGuest, onError) {
    const code = NetSession.makeCode();
    this.peer = new Peer(NET_PREFIX + code);
    this.peer.on('open', () => onCode(code));
    this.peer.on('connection', conn => {
      if (this.locked || this.peers.length >= this.maxGuests) {
        // Room is full or the game already started
        conn.on('open', () => {
          try { conn.send({ t: 'full' }); } catch (e) { /* closing anyway */ }
          setTimeout(() => conn.close(), 300);
        });
        return;
      }
      this.attach(conn, onGuest);
    });
    this.peer.on('error', err => {
      if (this.closed) return;
      if (err.type === 'unavailable-id' && this.peers.length === 0) {
        this.peer.destroy();
        this.host(onCode, onGuest, onError);
      } else if (this.peers.length === 0 && err.type !== 'peer-unavailable') {
        onError(err);
      }
    });
    this.startPing();
  }

  join(code, onConnect, onError) {
    this.peer = new Peer();
    this.peer.on('open', () => {
      const conn = this.peer.connect(NET_PREFIX + code, { reliable: true, serialization: 'json' });
      this.attach(conn, onConnect);
    });
    this.peer.on('error', err => {
      if (!this.closed && !this.connected) onError(err);
    });
    this.joinTimer = setTimeout(() => {
      if (!this.connected && !this.closed) onError({ type: 'timeout' });
    }, 12000);
    this.startPing();
  }

  // Keep-alive runs on a timer so a hidden tab still reports in
  startPing() {
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping' });
      const now = performance.now();
      this.peers.slice().forEach(p => {
        if (now - p.lastRecv > NET_TIMEOUT_MS) this.dropPeer(p);
      });
    }, 1000);
  }

  attach(conn, onOpen) {
    const peer = { conn, slot: 0, name: '', lastRecv: performance.now(), lastMap: '' };
    conn.on('open', () => {
      if (this.closed) return;
      peer.lastRecv = performance.now();
      this.peers.push(peer);
      clearTimeout(this.joinTimer);
      onOpen(peer);
    });
    conn.on('data', msg => {
      peer.lastRecv = performance.now();
      if (msg && msg.t !== 'ping') this.game.onNetMessage(msg, peer);
    });
    conn.on('close', () => this.dropPeer(peer));
    conn.on('error', () => this.dropPeer(peer));
  }

  dropPeer(peer) {
    const i = this.peers.indexOf(peer);
    if (i === -1 || this.closed) return;
    this.peers.splice(i, 1);
    try { peer.conn.close(); } catch (e) { /* already closed */ }
    if (this.isHost) {
      this.game.onGuestLeft(peer);
    } else {
      this.close();
      this.game.onNetLost();
    }
  }

  sendTo(peer, msg) {
    try {
      peer.conn.send(msg);
    } catch (e) {
      console.warn('Net send failed:', e);
    }
  }

  send(msg) {
    if (this.closed) return;
    this.peers.forEach(p => this.sendTo(p, msg));
  }

  // Host: one packet per rendered frame for every guest
  sendFrame(snapshot, mapCode) {
    this.peers.forEach(p => {
      const channel = p.conn.dataChannel;
      if (channel && channel.bufferedAmount > 1024 * 1024) return; // Congested: skip this frame
      let s = snapshot;
      if (mapCode !== p.lastMap) {
        s = Object.assign({ map: mapCode }, snapshot);
        p.lastMap = mapCode;
      }
      this.sendTo(p, { t: 'snap', s, ui: this.ui, ev: this.events });
    });
    this.ui = [];
    this.events = [];
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.joinTimer);
    this.peers.forEach(p => {
      try { p.conn.close(); } catch (e) { /* already closed */ }
    });
    this.peers = [];
    try {
      if (this.peer) this.peer.destroy();
    } catch (e) {
      // Already closed
    }
  }
}

// -------------------------------------------------------------
// Record host-side sounds & effects for replay on the guest
// -------------------------------------------------------------
const isNetHost = () => typeof game !== 'undefined' && game && game.net && game.net.isHost && game.net.connected;

NET_SOUNDS.forEach(name => {
  const orig = SoundEngine.prototype[name];
  sound[name] = function (...args) {
    if (isNetHost()) game.net.events.push({ s: name, a: args });
    return orig.apply(this, args);
  };
});

let netFxDepth = 0; // Only the outermost effect call is sent (nested ones replay by themselves)
NET_FX.forEach(name => {
  const orig = Game.prototype[name];
  Game.prototype[name] = function (...args) {
    if (netFxDepth === 0 && this.net && this.net.isHost && this.net.connected) {
      this.net.events.push({ f: name, a: args });
    }
    netFxDepth++;
    try {
      return orig.apply(this, args);
    } finally {
      netFxDepth--;
    }
  };
});
