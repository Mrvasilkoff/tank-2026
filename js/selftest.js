/**
 * TANK 2026 - Self-test bot
 * Open the game with ?selftest in the address (e.g. http://localhost:8765/?selftest).
 * Bots play every mode at full speed and the game's own functions are exercised;
 * a results table appears on top of the page (also in the console and window.__selftest).
 */

(function () {
  const results = [];
  const raf = window.requestAnimationFrame;

  // Simple bot: line up with the nearest enemy (or HQ / turret) and shoot
  function botInput(p) {
    if (!p || p.dead) return { dir: null, fire: false, tap: false };
    p.shieldTimer = Math.max(p.shieldTimer, 1);
    p.lives = Math.max(p.lives, 3);
    const targets = game.enemies.concat(game.cities.filter(c => c.alive), game.turrets.filter(t => t.alive));
    let t = null;
    let best = Infinity;
    targets.forEach(e => {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < best) { best = d; t = e; }
    });
    let dir;
    if (t) {
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      if (Math.abs(dx) < 8) dir = dy < 0 ? 'UP' : 'DOWN';
      else if (Math.abs(dy) < 8) dir = dx < 0 ? 'LEFT' : 'RIGHT';
      else dir = Math.abs(dx) < Math.abs(dy) ? (dx < 0 ? 'LEFT' : 'RIGHT') : (dy < 0 ? 'UP' : 'DOWN');
    } else {
      dir = 'UP';
    }
    if (Math.random() < 0.08) dir = DIR_ACTIONS[Math.floor(Math.random() * 4)];
    return { dir, fire: true, tap: false };
  }

  // Run the simulation (update + render) for some seconds of game time
  function simulate(seconds, { renderEvery = 6, untilState = null, protectBases = true } = {}) {
    const frames = Math.round(seconds * 60);
    for (let f = 0; f < frames; f++) {
      if (protectBases) game.bases.forEach(b => { b.hp = 99; b.alive = true; });
      if (game.state === 'UPGRADE') game.pickUpgrade(0);
      game.update(1 / 60);
      if (f % renderEvery === 0) game.render();
      if (untilState && game.state === untilState) return f / 60;
    }
    return seconds;
  }

  function withBots(fn) {
    const orig = game.readInput.bind(game);
    game.readInput = idx => botInput(game.players[idx]);
    try {
      return fn();
    } finally {
      game.readInput = orig;
    }
  }

  function expect(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  async function test(name, fn) {
    const t0 = performance.now();
    const loopErrors = [];
    const origErr = console.error;
    console.error = (...a) => { loopErrors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); origErr(...a); };
    try {
      const info = fn() || '';
      if (loopErrors.length) throw new Error(loopErrors[0]);
      results.push({ name, ok: true, ms: Math.round(performance.now() - t0), info: String(info) });
    } catch (e) {
      results.push({ name, ok: false, ms: Math.round(performance.now() - t0), info: (e && e.stack) || String(e) });
    } finally {
      console.error = origErr;
    }
    await new Promise(r => setTimeout(r, 0));
  }

  function startMode(twoPlayers, layout, count) {
    game.stopDemo();
    game.startNewGame(twoPlayers, layout, count);
    document.getElementById('stage-screen').classList.add('hidden');
    game.state = 'PLAYING';
  }

  async function run() {
    window.requestAnimationFrame = () => 0; // The tests drive the game themselves

    await test('Классика, 1 игрок: уровень проходится', () => withBots(() => {
      startMode(false, 'classic');
      const t = simulate(360, { untilState: 'TALLY' });
      expect(game.state === 'TALLY', 'уровень не завершился за 6 минут (state ' + game.state + ')');
      game.clearTallyTimers();
      game.tallyReady = true;
      game.nextStage();
      expect(game.stage === 2, 'не перешёл на 2-й уровень');
      return 'пройден за ' + Math.round(t) + ' с игрового времени';
    }));

    await test('Классика, 2 игрока', () => withBots(() => {
      startMode(true, 'classic');
      const t = simulate(360, { untilState: 'TALLY' });
      expect(game.state === 'TALLY', 'уровень не завершился (state ' + game.state + ')');
      return Math.round(t) + ' с';
    }));

    await test('Большая карта, 4 игрока', () => withBots(() => {
      startMode(true, 'big', 4);
      expect(game.bases.length === 2, 'штабов не два');
      const t = simulate(420, { untilState: 'TALLY' });
      expect(game.state === 'TALLY', 'уровень не завершился (state ' + game.state + ')');
      game.render();
      return Math.round(t) + ' с, 30 врагов';
    }));

    await test('Все бонусы (игрок и враг)', () => {
      ['classic', 'conquest'].forEach(layout => {
        startMode(false, layout);
        const p = game.players[0];
        ['star', 'helmet', 'clock', 'shovel', 'grenade', 'tank', 'gun', 'boat'].forEach(type => {
          game.applyPlayerPowerup(p, type);
          const e = new EnemyTank(p.x, Math.max(0, p.y - 120), { type: 'basic', hp: 1, points: 100, isFlashing: false });
          game.enemies.push(e);
          game.applyEnemyPowerup(e, type);
          if (p.dead) { p.dead = false; p.lives = 3; }
        });
        game.render();
      });
    });

    await test('CONQUEST: поход, сдвиг мира, крепость, босс', () => withBots(() => {
      startMode(false, 'conquest');
      let fortress = null;
      for (let k = 0; k < 8 && !fortress; k++) {
        game.shiftWorld(game.map.pushChunkOnTop());
        fortress = game.cities.find(c => c.boss);
      }
      expect(fortress, 'крепость не появилась за 8 участков');
      expect(game.turrets.length >= 5, 'турелей меньше 5: ' + game.turrets.length);
      // Bring the camera to the fortress and let things happen
      game.camY = Math.max(0, fortress.zone.y - 40);
      const p = game.players[0];
      p.x = 195;
      p.y = game.camY + 370;
      game.updateCamera = () => {}; // Keep the camera here for the test
      simulate(20);
      expect(game.bossSpawned[fortress.group], 'босс не появился');
      delete game.updateCamera;
      // Destroy every HQ of the fortress
      game.cities.filter(c => c.group === fortress.group).forEach(c => {
        while (c.alive) game.hitCity(c, { owner: 'player', x: c.x, y: c.y, shooter: p });
        if (game.state === 'UPGRADE') game.pickUpgrade(0);
      });
      expect(game.cities.filter(c => c.group === fortress.group).every(c => c.captured), 'крепость не захвачена');
      expect(game.turrets.filter(t => t.group === fortress.group).every(t => !t.alive), 'турели не уничтожены');
      expect(game.citiesCaptured >= 1, 'город не засчитан');
      return 'турелей ' + game.turrets.length + ', улучшения: ' + JSON.stringify(game.upgrades);
    }));

    await test('CONQUEST: улучшения, броня, ночь', () => {
      startMode(false, 'conquest');
      const p = game.players[0];
      game.upgrades = {};
      game.offerUpgrade();
      expect(game.state === 'UPGRADE' && game.upgradeChoices.length === 3, 'выбор улучшения не открылся');
      game.syncUpgradePanel();
      game.upgradeChoices = ['armor', 'speed', 'reload'];
      game.pickUpgrade(0);
      game.offerUpgrade();
      game.upgradeChoices = ['speed', 'armor', 'reload'];
      game.pickUpgrade(0);
      expect(game.state === 'PLAYING', 'игра не продолжилась после выбора');
      expect(p.armor === 1, 'броня не выдана: ' + p.armor);
      p.shieldTimer = 0;
      game.killPlayer(p);
      expect(!p.dead && p.armor === 0, 'броня не сработала');
      game.dayTime = DAY_LENGTH / 2;
      expect(game.darkness() > 0.5, 'ночь не наступает');
      game.render();
      return 'скорость ' + p.speed.toFixed(2);
    });

    await test('CONQUEST: артиллерия, мины, разведчик', () => {
      startMode(false, 'conquest');
      const p = game.players[0];
      p.shieldTimer = 0;
      const art = new EnemyTank(p.x, p.y - 150, { type: 'artillery', hp: 2, points: 300, isFlashing: false });
      const scout = new EnemyTank(p.x + 40, p.y - 120, { type: 'scout', hp: 1, points: 150, isFlashing: false });
      game.enemies.push(art, scout);
      simulate(6);
      expect(game.shells.length > 0 || game.explosions.length > 0 || p.dead || p.armor === 0, 'артиллерия не стреляла');
      expect(scout.called, 'разведчик не вызвал подкрепление');
      game.mines.push({ x: p.x + 13, y: p.y + 13, arm: 0, life: 10 });
      p.dead = false;
      p.shieldTimer = 0;
      p.armor = 0;
      const lives = p.lives;
      simulate(0.1);
      expect(p.dead || p.lives < lives, 'мина не сработала');
      return 'ok';
    });

    await test('CONQUEST, 2 игрока: 3 минуты боя', () => withBots(() => {
      startMode(true, 'conquest');
      simulate(180);
      expect(game.state === 'PLAYING' || game.state === 'UPGRADE', 'state ' + game.state);
      return 'путь ' + game.distanceRows + ', городов ' + game.citiesCaptured;
    }));

    await test('Сеть: снимок мира и карта', () => {
      startMode(true, 'conquest');
      simulate(2);
      const snap = JSON.parse(JSON.stringify(game.buildSnapshot()));
      expect(snap.p.length === 2 && Array.isArray(snap.ct), 'неполный снимок');
      const code = game.encodeMap();
      game.decodeMap(code);
      expect(game.encodeMap() === code, 'карта не совпала после передачи');
      return Math.round(JSON.stringify(snap).length / 1024 * 10) / 10 + ' КБ за кадр';
    });

    await test('Меню, пауза, настройки, рекорды', () => {
      startMode(false, 'classic');
      game.togglePause();
      game.syncPauseMenu();
      expect(game.menuName === 'pause', 'пауза-меню не открылось');
      game.resumeFromPause();
      game.syncPauseMenu();
      expect(game.state === 'PLAYING' && game.menuName !== 'pause', 'пауза не снялась');
      const keymap = JSON.stringify(game.keymap);
      game.setKeyBinding('p1', 'UP', 'KeyS');
      expect(game.keymap.p1.DOWN === 'KeyW', 'клавиши не поменялись местами');
      game.keymap = JSON.parse(keymap);
      applyKeyMap(game.keymap);
      saveJSON('tank2026_keys', game.keymap);
      const savedRecords = game.records.slice();
      game.recordScores();
      game.renderRecords();
      game.records = savedRecords;
      saveJSON('tank2026_records', game.records);
      ['main', 'settings', 'records', 'conquest', 'online'].forEach(m => game.showMenu(m));
    });

    window.requestAnimationFrame = raf;
    game.leaveOnline('');
    game.lastTime = 0;
    requestAnimationFrame(t => game.loop(t));
    report();
  }

  function report() {
    window.__selftest = results;
    console.table(results.map(r => ({ test: r.name, ok: r.ok, ms: r.ms, info: r.info.split('\n')[0] })));
    const box = document.createElement('div');
    box.id = 'selftest-report';
    Object.assign(box.style, {
      position: 'fixed', top: '10px', right: '10px', zIndex: 10000, maxWidth: '520px', maxHeight: '90vh', overflow: 'auto',
      background: 'rgba(10, 12, 16, 0.95)', border: '2px solid #444', borderRadius: '8px', padding: '12px',
      font: '12px/1.5 monospace', color: '#ddd'
    });
    const passed = results.filter(r => r.ok).length;
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:bold;margin-bottom:8px;color:' + (passed === results.length ? '#69f0ae' : '#ff5252');
    head.textContent = 'SELFTEST: ' + passed + ' / ' + results.length + ' пройдено';
    box.appendChild(head);
    results.forEach(r => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      row.textContent = (r.ok ? '✔ ' : '✘ ') + r.name + ' (' + r.ms + ' мс)' + (r.info ? ' — ' + r.info.split('\n').slice(0, r.ok ? 1 : 3).join(' | ') : '');
      row.style.color = r.ok ? '#c8e6c9' : '#ff8a80';
      box.appendChild(row);
    });
    document.body.appendChild(box);
  }

  setTimeout(run, 500);
})();
