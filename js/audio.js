/**
 * TANK 2026 - Authentic 8-bit Web Audio API Chiptune Engine
 * Simulates Ricoh 2A03 APU (Square 1, Square 2, Triangle, and Noise channels)
 */

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.engineOsc = null;
    this.engineGain = null;
    this.isMoving = false;
    this.hasInteracted = false;
  }

  init() {
    if (this.ctx) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.hasInteracted = true;
      this.startEngineHum();
    } catch (e) {
      console.warn("AudioContext init failed:", e);
    }
  }

  ensureContext() {
    if (!this.ctx) {
      this.init();
    } else if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.engineGain) {
      this.engineGain.gain.setValueAtTime(this.muted ? 0 : (this.isMoving ? 0.08 : 0.02), this.ctx.currentTime);
    }
    return !this.muted;
  }

  // Continuous tank engine sound
  startEngineHum() {
    if (!this.ctx) return;
    try {
      this.engineOsc = this.ctx.createOscillator();
      this.engineGain = this.ctx.createGain();

      this.engineOsc.type = 'sawtooth';
      this.engineOsc.frequency.setValueAtTime(55, this.ctx.currentTime); // Low 55Hz drone

      // Lowpass filter to muffle the saw wave like an engine
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(140, this.ctx.currentTime);

      this.engineGain.gain.setValueAtTime(0, this.ctx.currentTime);

      this.engineOsc.connect(filter);
      filter.connect(this.engineGain);
      this.engineGain.connect(this.ctx.destination);

      this.engineOsc.start();
    } catch (e) {
      // Ignore
    }
  }

  setEngineState(moving, isPlayerActive = true) {
    if (!this.ctx || !this.engineGain || this.muted || !isPlayerActive) {
      if (this.engineGain) this.engineGain.gain.setValueAtTime(0, this.ctx?.currentTime || 0);
      return;
    }
    this.isMoving = moving;
    const now = this.ctx.currentTime;
    if (moving) {
      this.engineOsc.frequency.setTargetAtTime(90, now, 0.05);
      this.engineGain.gain.setTargetAtTime(0.06, now, 0.05);
    } else {
      this.engineOsc.frequency.setTargetAtTime(50, now, 0.1);
      this.engineGain.gain.setTargetAtTime(0.015, now, 0.1);
    }
  }

  stopEngineHum() {
    if (this.engineGain && this.ctx) {
      this.engineGain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    if (this.enemyHum && this.ctx) {
      this.enemyHum.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  // Shared white noise for gunshots (created once, reused at random offsets)
  getNoiseBuffer() {
    if (!this.noiseBuffer) {
      const len = Math.floor(this.ctx.sampleRate);
      const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    return this.noiseBuffer;
  }

  // Soft saturation curve: gives the shot a punchy, compressed edge
  getDriveCurve() {
    if (!this.driveCurve) {
      const n = 1024;
      this.driveCurve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this.driveCurve[i] = Math.tanh(2.2 * (i * 2 / n - 1));
      }
    }
    return this.driveCurve;
  }

  // 1. Tank cannon shot: sharp muzzle crack + low rumbling boom + recoil thump.
  //    tier 1..4: more weapon stars = heavier, deeper and longer shot
  playShoot(tier = 1) {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const heavy = Math.max(0, Math.min(3, tier - 1)) / 3; // 0..1
    const noise = this.getNoiseBuffer();

    const mix = ctx.createGain();
    const drive = ctx.createWaveShaper();
    drive.curve = this.getDriveCurve();
    const master = ctx.createGain();
    master.gain.value = 0.2; // About as loud as the old beep, quieter than explosions
    mix.connect(drive);
    drive.connect(master);
    master.connect(ctx.destination);

    // a) Muzzle crack: very short bright noise burst
    const crack = ctx.createBufferSource();
    crack.buffer = noise;
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.value = 1800;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.55, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(mix);
    crack.start(now, Math.random() * 0.5, 0.05);

    // b) Boom: noise through a closing low-pass (the blast rolling off)
    const boomLen = 0.26 + 0.14 * heavy;
    const boom = ctx.createBufferSource();
    boom.buffer = noise;
    const boomFilter = ctx.createBiquadFilter();
    boomFilter.type = 'lowpass';
    boomFilter.Q.value = 0.8;
    boomFilter.frequency.setValueAtTime(1500 - 500 * heavy, now);
    boomFilter.frequency.exponentialRampToValueAtTime(110, now + boomLen);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(0.0001, now);
    boomGain.gain.linearRampToValueAtTime(0.6, now + 0.004);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + boomLen);
    boom.connect(boomFilter);
    boomFilter.connect(boomGain);
    boomGain.connect(mix);
    boom.start(now, Math.random() * 0.4, boomLen + 0.05);

    // c) Recoil thump: falling sine for weight in the low end
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(165 - 35 * heavy, now);
    thump.frequency.exponentialRampToValueAtTime(42, now + 0.16 + 0.06 * heavy);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.65 + 0.2 * heavy, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2 + 0.08 * heavy);
    thump.connect(thumpGain);
    thumpGain.connect(mix);
    thump.start(now);
    thump.stop(now + 0.32);
  }

  // 2. Bullet Hit Steel / Armor / Boundary (Clank)
  playHitSteel() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.setValueAtTime(1800, now + 0.02);
    osc.frequency.setValueAtTime(900, now + 0.05);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  // 3. Bullet Hit Brick (Crunch)
  playHitBrick() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    // Noise buffer
    const bufferSize = this.ctx.sampleRate * 0.08;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.exponentialRampToValueAtTime(200, now + 0.08);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
  }

  // 4. Tank Explosion (Boom)
  playExplosion(large = false) {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;
    const duration = large ? 0.6 : 0.35;

    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(large ? 400 : 300, now);
    filter.frequency.exponentialRampToValueAtTime(40, now + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(large ? 0.5 : 0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.005, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
  }

  // 5. Power-up Spawn
  playPowerUpSpawn() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    const freqs = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    freqs.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + idx * 0.06);

      gain.gain.setValueAtTime(0, now + idx * 0.06);
      gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.06 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.06 + 0.07);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + idx * 0.06);
      osc.stop(now + idx * 0.06 + 0.08);
    });
  }

  // Short chiptune note: wave 'square' | 'triangle' | 'sawtooth' | 'sine', optional pitch slide
  blip(wave, freq, at, dur, vol, endFreq = null) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Filtered noise burst
  noiseBurst(at, dur, vol, type, freq, endFreq = null) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(ctx.destination);
    src.start(t, Math.random() * 0.4, dur + 0.05);
  }

  // 6. Power-up picked up: a different jingle for every bonus ('enemy' = an enemy took it)
  playPowerUpCollect(type = 'star') {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const arp = (wave, notes, step, dur, vol) =>
      notes.forEach((f, i) => this.blip(wave, f, i * step, dur, vol));
    switch (type) {
      case 'star':     // Bright rising sparkle
        arp('square', [659, 880, 1175, 1568, 2093], 0.045, 0.09, 0.15);
        this.blip('triangle', 2637, 0.25, 0.25, 0.1);
        break;
      case 'gun':      // Charging up, then a heavy clack
        this.blip('sawtooth', 120, 0, 0.35, 0.12, 900);
        this.noiseBurst(0.36, 0.12, 0.25, 'lowpass', 1200, 200);
        this.blip('square', 196, 0.36, 0.15, 0.15);
        break;
      case 'helmet':   // Shimmering shield
        for (let i = 0; i < 6; i++) this.blip('triangle', i % 2 ? 1320 : 990, i * 0.05, 0.12, 0.12);
        this.blip('sine', 660, 0, 0.45, 0.08, 1320);
        break;
      case 'clock':    // Tick-tock, then a frozen chime
        [0, 0.12, 0.24, 0.36].forEach((t, i) => this.noiseBurst(t, 0.03, 0.3, 'highpass', i % 2 ? 3000 : 5000));
        this.blip('triangle', 1760, 0.5, 0.4, 0.12, 880);
        break;
      case 'shovel':   // Clank-clank of steel plates
        [0, 0.12, 0.24].forEach(t => {
          this.blip('square', 220, t, 0.06, 0.12, 140);
          this.noiseBurst(t, 0.05, 0.18, 'bandpass', 2500);
        });
        this.blip('triangle', 523, 0.36, 0.2, 0.12);
        break;
      case 'grenade':  // Falling whistle into a boom
        this.blip('square', 1800, 0, 0.3, 0.07, 300);
        this.noiseBurst(0.3, 0.5, 0.45, 'lowpass', 800, 60);
        this.blip('sine', 90, 0.3, 0.4, 0.4, 35);
        break;
      case 'tank':     // Extra life jingle
        arp('square', [523, 659, 784, 659, 784, 1047], 0.07, 0.1, 0.14);
        break;
      case 'boat':     // Wavy wobble
        for (let i = 0; i < 5; i++) this.blip('triangle', i % 2 ? 440 : 523, i * 0.07, 0.12, 0.14);
        this.noiseBurst(0, 0.4, 0.08, 'bandpass', 600, 1500);
        break;
      case 'enemy':    // An enemy stole the bonus: low sinister falling notes
        arp('sawtooth', [392, 311, 233, 175], 0.08, 0.14, 0.1);
        break;
      default:
        arp('square', [440, 554, 659, 880, 1108], 0.05, 0.08, 0.15);
    }
  }

  // Shell impacts: 'steel' wall ping, 'armor' clank on a tank, 'shield' energy zap,
  // 'bullet' two shells colliding
  playRicochet(kind = 'steel') {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const v = 0.9 + Math.random() * 0.25; // Slight pitch variation each time
    if (kind === 'steel') {
      this.blip('triangle', 2400 * v, 0, 0.18, 0.12, 1500 * v);
      this.blip('square', 3600 * v, 0, 0.04, 0.05);
      this.noiseBurst(0, 0.05, 0.15, 'highpass', 3000);
    } else if (kind === 'armor') {
      this.blip('square', 300 * v, 0, 0.09, 0.14, 160 * v);
      this.blip('triangle', 900 * v, 0, 0.12, 0.1, 600 * v);
      this.noiseBurst(0, 0.08, 0.22, 'bandpass', 1400);
    } else if (kind === 'shield') {
      this.blip('sawtooth', 1600 * v, 0, 0.14, 0.07, 400 * v);
      this.blip('sine', 2200 * v, 0.02, 0.1, 0.08, 3300 * v);
    } else {
      this.noiseBurst(0, 0.06, 0.28, 'highpass', 2000);
      this.blip('square', 1200 * v, 0, 0.05, 0.08, 2400 * v);
    }
  }

  // Artillery firing: a hollow mortar thump
  playMortar() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    this.blip('sine', 110, 0, 0.25, 0.25, 50);
    this.noiseBurst(0, 0.15, 0.15, 'lowpass', 600, 150);
  }

  // Distant rumble of the enemy tanks on the field (count = moving enemies)
  setEnemyEngine(count) {
    if (!this.ctx) return;
    if (!this.enemyHum) {
      try {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 38;
        const wobble = this.ctx.createOscillator();
        const wobbleDepth = this.ctx.createGain();
        wobble.frequency.value = 7;
        wobbleDepth.gain.value = 4;
        wobble.connect(wobbleDepth);
        wobbleDepth.connect(osc.frequency);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 110;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        wobble.start();
        this.enemyHum = gain;
      } catch (e) {
        return;
      }
    }
    const level = this.muted ? 0 : Math.min(0.05, count * 0.011);
    this.enemyHum.gain.setTargetAtTime(level, this.ctx.currentTime, 0.25);
  }

  // 7. Authentic Stage Start Intro Fanfare (Classic Battle City intro!)
  playStageStart(callback) {
    if (this.muted || !this.ctx) {
      if (callback) setTimeout(callback, 800);
      return;
    }
    this.ensureContext();
    const now = this.ctx.currentTime;

    // Classic NES Battle City intro melody:
    // Notes and durations (in sixteenth notes at ~140 bpm -> ~0.107s each)
    const tempo = 0.11;
    const melody = [
      { f: 261.63, d: 1 }, // C4
      { f: 392.00, d: 1 }, // G4
      { f: 523.25, d: 1 }, // C5
      { f: 659.25, d: 1 }, // E5
      { f: 587.33, d: 1 }, // D5
      { f: 493.88, d: 1 }, // B4
      { f: 392.00, d: 1 }, // G4
      { f: 523.25, d: 2 }, // C5
      { f: 0,      d: 1 }, // Rest
      { f: 523.25, d: 1 }, // C5
      { f: 659.25, d: 1 }, // E5
      { f: 783.99, d: 2 }, // G5
      { f: 659.25, d: 1 }, // E5
      { f: 783.99, d: 3 }, // G5
    ];

    let t = now;
    melody.forEach(note => {
      if (note.f > 0) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(note.f, t);

        const dur = note.d * tempo;
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + dur * 0.9);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(t);
        osc.stop(t + dur);
      }
      t += note.d * tempo;
    });

    const totalDur = (t - now) * 1000;
    if (callback) {
      setTimeout(callback, totalDur + 100);
    }
  }

  // 8. Game Over Fanfare
  playGameOver() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    const notes = [
      { f: 440, d: 0.18 }, // A4
      { f: 415.3, d: 0.18 }, // G#4
      { f: 392, d: 0.18 }, // G4
      { f: 349.2, d: 0.4 }, // F4
      { f: 329.6, d: 0.6 }  // E4
    ];

    let t = now;
    notes.forEach(note => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note.f, t);

      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + note.d * 0.95);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + note.d);
      t += note.d;
    });
  }

  // 9. Tally Score Beep (End of Stage counter)
  playTallyBeep() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(800, now);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.055);
  }

  // 10. Bonus Tank Beep Warning
  playBonusAlert() {
    if (this.muted || !this.ctx) return;
    this.ensureContext();
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(987.77, now); // B5
    osc.frequency.setValueAtTime(1318.51, now + 0.05); // E6

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }
}

// Global sound instance
const sound = new SoundEngine();
