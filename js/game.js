/**
 * TANK 2026 - Master Game Controller & Simulation Engine
 * Manages game states, tile grid physics with sub-tile quadrant destruction,
 * enemy spawning, bonus mechanics, stage tally, HUD updates, and controls.
 */

class GameMap {
  constructor() {
    this.cols = MapGenerator.COLS;
    this.rows = MapGenerator.ROWS;
    this.tileSize = Sprites.TILE_SIZE; // 16px
    this.pxW = this.cols * this.tileSize; // Field size in logical px
    this.pxH = this.rows * this.tileSize;
    this.game = null;

    // Tile grid: 26x26 (classic) or 52x26 (big)
    this.grid = null;
    // Bunker tiles -> their Eagle (for the shovel flashing)
    this.fortOwner = new Map();
    // Water tiles frozen for the night (keys r * cols + c)
    this.frozen = new Set();
    // Brick mask: 4 bits per tile (bit 0: TL, bit 1: TR, bit 2: BL, bit 3: BR)
    // 15 (0b1111) means fully intact, 0 means destroyed
    this.brickMasks = [];
    this.archetype = '';
    this.stage = 1;
    this.seed = 0;
  }

  loadLevel(stage = 1, customSeed = null, layoutName = 'classic') {
    this.stage = stage;
    if (layoutName === 'conquest') {
      this.loadConquest(customSeed !== null ? customSeed : Math.floor(Math.random() * 9999999));
      return [];
    }
    const generated = layoutName === 'big'
      ? MapGenerator.generateWide(stage, customSeed)
      : MapGenerator.generate(stage, customSeed);
    this.grid = generated.grid;
    this.rows = this.grid.length;
    this.cols = this.grid[0].length;
    this.pxW = this.cols * this.tileSize;
    this.pxH = this.rows * this.tileSize;
    this.archetype = generated.archetype;
    this.seed = generated.seed;

    // Initialize brick masks
    this.brickMasks = [];
    for (let y = 0; y < this.rows; y++) {
      this.brickMasks[y] = new Uint8Array(this.cols);
      for (let x = 0; x < this.cols; x++) {
        if (this.grid[y][x] === MapGenerator.TILES.BRICK) {
          this.brickMasks[y][x] = 0x0F; // Full 4 quarters
        } else {
          this.brickMasks[y][x] = 0;
        }
      }
    }

    return generated.enemyPool;
  }

  // -------------------------------------------------------------
  // CONQUEST WORLD: three chunks of 26 rows, top to bottom; new land is pushed on top
  // -------------------------------------------------------------
  loadConquest(seed) {
    this.conquestSeed = seed;
    this.frozen = new Set();
    this.nextChunk = 0;
    const chunks = [this.makeChunk(), this.makeChunk(), this.makeChunk()].reverse(); // [top, middle, start]
    this.grid = [];
    this.chunkArchetypes = [];
    this.newCities = [];
    this.newFinds = [];
    this.newTurrets = [];
    chunks.forEach((chunk, i) => {
      chunk.grid.forEach(row => this.grid.push(row));
      this.chunkArchetypes.push(chunk.archetype);
      this.collectChunkContent(chunk, i * MapGenerator.ROWS);
    });
    this.rows = this.grid.length;
    this.cols = this.grid[0].length;
    this.pxW = this.cols * this.tileSize;
    this.pxH = this.rows * this.tileSize;
    this.archetype = this.chunkArchetypes[2];
    this.rebuildBrickMasks();
  }

  makeChunk() {
    const index = this.nextChunk++;
    return MapGenerator.generateConquestChunk(index, this.conquestSeed + index * 7919);
  }

  // Cities and ground bonuses of a chunk, converted to world tile rows
  collectChunkContent(chunk, rowOffset) {
    if (chunk.city) this.newCities.push(Object.assign({}, chunk.city, { rowOffset }));
    if (chunk.citadel) {
      const group = 'g' + rowOffset + '-' + this.nextChunk; // Unique per fortress
      chunk.citadel.hqs.forEach(h => this.newCities.push(Object.assign({}, h, { rowOffset, group, boss: true })));
      chunk.citadel.turrets.forEach(t => this.newTurrets.push({ x: t.x, y: t.y + rowOffset, group }));
    }
    chunk.finds.forEach(f => this.newFinds.push({ x: f.x, y: f.y + rowOffset }));
  }

  // New land on top, the bottom chunk (one screen behind the camera) is dropped.
  // Returns how many px everything has to move down.
  pushChunkOnTop() {
    const chunk = this.makeChunk();
    const keep = this.rows - MapGenerator.ROWS;
    const oldMasks = this.brickMasks;
    this.grid = chunk.grid.concat(this.grid.slice(0, keep));
    this.brickMasks = [];
    for (let r = 0; r < MapGenerator.ROWS; r++) {
      this.brickMasks.push(new Uint8Array(this.cols).map((_, c) => this.grid[r][c] === MapGenerator.TILES.BRICK ? 0x0F : 0));
    }
    this.brickMasks = this.brickMasks.concat(oldMasks.slice(0, keep));
    // Frozen water moves down with its rows
    const shift = MapGenerator.ROWS * this.cols;
    this.frozen = new Set(Array.from(this.frozen).map(k => k + shift).filter(k => k < this.rows * this.cols));
    this.chunkArchetypes = [chunk.archetype].concat(this.chunkArchetypes.slice(0, 2));
    this.newCities = [];
    this.newFinds = [];
    this.newTurrets = [];
    this.collectChunkContent(chunk, 0);
    return MapGenerator.ROWS * this.tileSize;
  }

  rebuildBrickMasks() {
    this.brickMasks = [];
    for (let y = 0; y < this.rows; y++) {
      this.brickMasks[y] = new Uint8Array(this.cols);
      for (let x = 0; x < this.cols; x++) {
        this.brickMasks[y][x] = this.grid[y][x] === MapGenerator.TILES.BRICK ? 0x0F : 0;
      }
    }
  }

  // Rebuild (or remove) bunker walls; defaults to the walls of every Eagle
  setBaseWalls(tileType, walls = null) {
    const tanks = this.game ? this.game.players.concat(this.game.enemies).filter(t => !t.dead) : [];
    const list = walls || (this.game ? [].concat(...this.game.bases.map(b => b.walls)) : MapGenerator.BASE_FORT_WALLS);
    list.forEach(pt => {
      // Never rebuild a wall on top of a tank: it would be trapped inside the tile and unhittable
      if (tileType !== MapGenerator.TILES.EMPTY &&
          tanks.some(t => this.rectsOverlap(t.x, t.y, t.w, t.h, pt.x * this.tileSize, pt.y * this.tileSize, this.tileSize, this.tileSize))) {
        return;
      }
      this.grid[pt.y][pt.x] = tileType;
      if (tileType === MapGenerator.TILES.BRICK) {
        this.brickMasks[pt.y][pt.x] = 0x0F;
      }
    });
  }

  // skipScreen: ignore the conquest screen edges (used to test whether a tank is stuck in something)
  isBlocked(x, y, w, h, hasBoat = false, ignoreTank = null, skipScreen = false) {
    // 1. Boundary
    if (x < 0 || x + w > this.pxW || y < 0 || y + h > this.pxH) return true;
    const game = this.game;
    if (game && game.layout.conquest) {
      // Screen edges block only moves that go further out, so a tank caught
      // half outside can always come back in
      const top = game.camY;
      const bottom = game.camY + game.viewH();
      if (ignoreTank && !skipScreen) {
        const outward = (y + h > bottom && y >= ignoreTank.y) || (y < top && y <= ignoreTank.y);
        // Players cannot drive off the screen (the camera follows them)
        if (ignoreTank.type === 'player' && outward) return true;
        // Enemies cannot slip away through the bottom: every one of them has to be destroyed
        if (ignoreTank.type !== 'player' && y + h > bottom && y >= ignoreTank.y) return true;
      }
      for (const city of game.cities) {
        if (city.alive && x < city.x + 32 && x + w > city.x && y < city.y + 32 && y + h > city.y) return true;
      }
      for (const tu of game.turrets) {
        if (tu.alive && x < tu.x + tu.w && x + w > tu.x && y < tu.y + tu.h && y + h > tu.y) return true;
      }
    }

    // 2. Tile bounds
    const startCol = Math.floor(x / this.tileSize);
    const endCol = Math.floor((x + w - 1) / this.tileSize);
    const startRow = Math.floor(y / this.tileSize);
    const endRow = Math.floor((y + h - 1) / this.tileSize);

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;

        const tile = this.grid[r][c];
        if (tile === MapGenerator.TILES.BRICK) {
          if (ignoreTank && ignoreTank.isBoss) continue; // The boss crushes brick walls
          // Check if the specific overlapping 8x8 sub-quadrant is solid
          if (this.isSubBrickSolid(c, r, x, y, w, h)) {
            return true;
          }
        } else if (tile === MapGenerator.TILES.STEEL) {
          return true;
        } else if (tile === MapGenerator.TILES.WATER) {
          if (!hasBoat) return true; // Blocked unless tank has boat!
        }
      }
    }

    // 3. Base collision
    if (this.game && this.game.bases) {
      for (const base of this.game.bases) {
        if (base.alive && x < base.x + base.w && x + w > base.x && y < base.y + base.h && y + h > base.y) {
          return true;
        }
      }
    }

    // 4. Tank vs Tank collision
    if (this.game && this.game.players) {
      for (const p of this.game.players) {
        if (p !== ignoreTank && !p.dead) {
          if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) {
            return true;
          }
        }
      }
    }

    if (this.game && this.game.enemies) {
      // Deadlocked enemies may drive through each other for a moment (see EnemyTank.update)
      const ghostMover = ignoreTank && ignoreTank.type !== 'player' && ignoreTank.ghostTimer > 0;
      for (const enemy of this.game.enemies) {
        if (enemy !== ignoreTank && !enemy.dead) {
          if ((ghostMover || enemy.ghostTimer > 0) && ignoreTank && ignoreTank.type !== 'player') continue;
          if (x < enemy.x + enemy.w && x + w > enemy.x &&
              y < enemy.y + enemy.h && y + h > enemy.y) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // True if a 26px tank standing at px (x, y) is shut in: a flood fill over 2x2-tile spots that are
  // not steel or water (brick counts as open: tanks shoot through it) finds fewer than `need` spots
  isEnclosed(x, y, need = 24) {
    const T = MapGenerator.TILES;
    const c0 = Math.round((x - 3) / this.tileSize);
    const r0 = Math.round((y - 3) / this.tileSize);
    const open = (c, r) => c >= 0 && r >= 0 && c + 1 < this.cols && r + 1 < this.rows &&
      [this.grid[r][c], this.grid[r][c + 1], this.grid[r + 1][c], this.grid[r + 1][c + 1]]
        .every(t => t !== T.STEEL && t !== T.WATER);
    if (!open(c0, r0)) return true;
    const seen = new Set([r0 * this.cols + c0]);
    const queue = [[c0, r0]];
    while (queue.length) {
      const [c, r] = queue.shift();
      if (seen.size >= need) return false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc;
        const nr = r + dr;
        const key = nr * this.cols + nc;
        if (seen.has(key) || !open(nc, nr)) continue;
        seen.add(key);
        queue.push([nc, nr]);
      }
    }
    return true;
  }

  isSubBrickSolid(c, r, tx, ty, tw, th) {
    const mask = this.brickMasks[r][c];
    if (mask === 0) return false;

    const tileX = c * this.tileSize;
    const tileY = r * this.tileSize;

    // Check each of the 4 sub-quadrants (8x8)
    // TL (bit 0: 0x1)
    if ((mask & 0x1) && this.rectsOverlap(tx, ty, tw, th, tileX, tileY, 8, 8)) return true;
    // TR (bit 1: 0x2)
    if ((mask & 0x2) && this.rectsOverlap(tx, ty, tw, th, tileX + 8, tileY, 8, 8)) return true;
    // BL (bit 2: 0x4)
    if ((mask & 0x4) && this.rectsOverlap(tx, ty, tw, th, tileX, tileY + 8, 8, 8)) return true;
    // BR (bit 3: 0x8)
    if ((mask & 0x8) && this.rectsOverlap(tx, ty, tw, th, tileX + 8, tileY + 8, 8, 8)) return true;

    return false;
  }

  rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
    return (x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2);
  }

  isOnIce(cx, cy) {
    const col = Math.floor(cx / this.tileSize);
    const row = Math.floor(cy / this.tileSize);
    if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
      return this.grid[row][col] === MapGenerator.TILES.ICE;
    }
    return false;
  }

  /**
   * Authentic Battle City Sub-Brick Destruction
   * Bullets chip away the half or quadrant they hit
   */
  hitTileWithBullet(bullet) {
    const minCol = Math.max(0, Math.floor((bullet.x + 1) / this.tileSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((bullet.x + bullet.w - 1) / this.tileSize));
    const minRow = Math.max(0, Math.floor((bullet.y + 1) / this.tileSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((bullet.y + bullet.h - 1) / this.tileSize));

    let hit = false;
    let pinged = false; // A shell bounced off steel
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const tile = this.grid[r][c];

        if (tile === MapGenerator.TILES.BRICK) {
          const tileX = c * this.tileSize;
          const tileY = r * this.tileSize;
          let mask = this.brickMasks[r][c];
          if (mask === 0) continue; // Already destroyed

          // Check which sub-quadrants overlap the bullet
          const hitsTL = (mask & 0x1) && this.rectsOverlap(bullet.x, bullet.y, bullet.w, bullet.h, tileX, tileY, 8, 8);
          const hitsTR = (mask & 0x2) && this.rectsOverlap(bullet.x, bullet.y, bullet.w, bullet.h, tileX + 8, tileY, 8, 8);
          const hitsBL = (mask & 0x4) && this.rectsOverlap(bullet.x, bullet.y, bullet.w, bullet.h, tileX, tileY + 8, 8, 8);
          const hitsBR = (mask & 0x8) && this.rectsOverlap(bullet.x, bullet.y, bullet.w, bullet.h, tileX + 8, tileY + 8, 8, 8);

          if (!hitsTL && !hitsTR && !hitsBL && !hitsBR) {
            // Bullet passed through already hollowed part
            continue;
          }

          if (bullet.canBreakSteel) {
            this.grid[r][c] = MapGenerator.TILES.EMPTY;
            this.brickMasks[r][c] = 0;
            hit = true;
          } else {
            // Classic Battle City sub-tile quadrant destruction
            let removeMask = 0;
            if (bullet.direction === 'UP') {
              if (mask & 0x0C) removeMask = 0x0C;
              else removeMask = 0x03;
            } else if (bullet.direction === 'DOWN') {
              if (mask & 0x03) removeMask = 0x03;
              else removeMask = 0x0C;
            } else if (bullet.direction === 'LEFT') {
              if (mask & 0x0A) removeMask = 0x0A;
              else removeMask = 0x05;
            } else if (bullet.direction === 'RIGHT') {
              if (mask & 0x05) removeMask = 0x05;
              else removeMask = 0x0A;
            }

            mask &= ~removeMask;
            this.brickMasks[r][c] = mask;
            if (mask === 0) {
              this.grid[r][c] = MapGenerator.TILES.EMPTY;
            }
            hit = true;
          }
          if (this.game) this.game.spawnBrickDebris(bullet.x, bullet.y);
        } else if (tile === MapGenerator.TILES.STEEL) {
          if (bullet.canBreakSteel) {
            this.grid[r][c] = MapGenerator.TILES.EMPTY;
            if (this.game) this.game.spawnBrickDebris(bullet.x, bullet.y);
          } else {
            if (this.game) this.game.spawnRicochetSparks(bullet.x, bullet.y);
            pinged = true;
          }
          hit = true;
        } else if (tile === MapGenerator.TILES.TREES && bullet.canBreakSteel) {
          this.grid[r][c] = MapGenerator.TILES.EMPTY;
          if (this.game) this.game.spawnLeafBurst(c * this.tileSize + 8, r * this.tileSize + 8);
          hit = true;
        }
      }
    }

    if (hit) {
      // Enemy shells hit walls silently; only the players' shells make impact sounds
      if (bullet.owner !== 'player') return true;
      if (bullet.canBreakSteel) sound.playExplosion(false);
      else if (pinged) sound.playRicochet('steel');
      else sound.playHitBrick();
      return true;
    }
    return false;
  }

  render(ctx, renderTrees = false, waterFrame = 0) {
    if (!this.grid) return;
    const ts = this.tileSize;
    const T = Sprites.TEX;      // Source texture size of one tile
    const H = T / 2;            // ...and of one 8x8 sub-quadrant
    // Glint sweeping diagonally across all ice tiles
    const glint = ((Date.now() / 1000) * 110) % 900 - 120 + (this.game ? this.game.camY : 0); // Screen-relative sweep

    if (!renderTrees) this.renderShadows(ctx);

    const [r0, r1] = this.visibleRows();
    for (let r = r0; r <= r1; r++) {
      for (let c = 0; c < this.cols; c++) {
        const tile = this.grid[r][c];
        const px = c * ts;
        const py = r * ts;

        if (renderTrees) {
          // Upper canopy layer (volumetric foliage)
          if (tile === MapGenerator.TILES.TREES) {
            // Canopy shakes while a tank drives under it or a shell flies through
            const shake = this.game ? this.game.treeRustle.get(r * this.cols + c) : 0;
            let ox = 0;
            let oy = 0;
            if (shake) {
              const amp = Math.min(1, shake / 0.4) * 0.8;
              ox = Math.sin(Date.now() / 45 + c * 1.7) * amp;
              oy = Math.cos(Date.now() / 60 + r * 1.3) * amp * 0.6;
            }
            ctx.drawImage(Sprites.cache['trees'], 0, 0, T, T, px + ox, py + oy, 16, 16);
          }
          continue;
        }

        // Lower terrain layer
        switch (tile) {
          case MapGenerator.TILES.BRICK: {
            const mask = this.brickMasks[r][c];
            if (mask === 0x0F) {
              ctx.drawImage(Sprites.cache['brick'], 0, 0, T, T, px, py, 16, 16);
            } else if (mask > 0) {
              // Draw only intact 8x8 sub-quadrants
              if (mask & 0x1) ctx.drawImage(Sprites.cache['brick'], 0, 0, H, H, px, py, 8, 8);
              if (mask & 0x2) ctx.drawImage(Sprites.cache['brick'], H, 0, H, H, px + 8, py, 8, 8);
              if (mask & 0x4) ctx.drawImage(Sprites.cache['brick'], 0, H, H, H, px, py + 8, 8, 8);
              if (mask & 0x8) ctx.drawImage(Sprites.cache['brick'], H, H, H, H, px + 8, py + 8, 8, 8);
            }
            break;
          }
          case MapGenerator.TILES.STEEL: {
            // If shovel fortification is flashing, alternate between brick and steel look
            const owner = this.fortOwner.get(r * this.cols + c);
            if (owner && owner.shovelFlashing && (Math.floor(Date.now() / 200) % 2 === 0)) {
              ctx.drawImage(Sprites.cache['brick'], 0, 0, T, T, px, py, 16, 16);
            } else {
              ctx.drawImage(Sprites.cache['steel'], 0, 0, T, T, px, py, 16, 16);
            }
            break;
          }
          case MapGenerator.TILES.WATER: {
            const waterSprite = Sprites.cache['water' + (waterFrame % Sprites.WATER_FRAMES)] || Sprites.cache['water0'];
            ctx.drawImage(waterSprite, 0, 0, T, T, px, py, 16, 16);
            break;
          }
          case MapGenerator.TILES.ICE: {
            ctx.drawImage(Sprites.cache['ice'], 0, 0, T, T, px, py, 16, 16);
            const diag = px + py;
            if (diag > glint - 34 && diag < glint + 2) {
              // Stripe of points where x + y is between c1 and c2, clipped to this tile
              const stripe = (c1, c2, alpha) => {
                ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
                ctx.beginPath();
                ctx.moveTo(c1 - py, py);
                ctx.lineTo(c2 - py, py);
                ctx.lineTo(c2 - py - 16, py + 16);
                ctx.lineTo(c1 - py - 16, py + 16);
                ctx.closePath();
                ctx.fill();
              };
              ctx.save();
              ctx.beginPath();
              ctx.rect(px, py, 16, 16);
              ctx.clip();
              stripe(glint - 10, glint, 0.22);
              stripe(glint - 5, glint - 3, 0.5);
              ctx.restore();
            }
            break;
          }
        }
      }
    }

    if (!renderTrees) this.renderShoreline(ctx);
  }

  // Rows on screen (the whole map outside conquest)
  visibleRows() {
    if (!this.game || !this.game.layout.conquest) return [0, this.rows - 1];
    const top = Math.floor(this.game.camY / this.tileSize) - 1;
    const bottom = Math.floor((this.game.camY + this.game.viewH()) / this.tileSize) + 1;
    return [Math.max(0, top), Math.min(this.rows - 1, bottom)];
  }

  // Soft drop shadows of walls and tree canopies (light from the top-left)
  renderShadows(ctx) {
    const T = MapGenerator.TILES;
    const ts = this.tileSize;
    const layers = [[1.5, 2, 'rgba(0, 0, 0, 0.22)'], [3, 4, 'rgba(0, 0, 0, 0.14)']];
    layers.forEach(([ox, oy, color]) => {
      ctx.beginPath();
      const [r0, r1] = this.visibleRows();
      for (let r = r0; r <= r1; r++) {
        for (let c = 0; c < this.cols; c++) {
          const tile = this.grid[r][c];
          const px = c * ts + ox;
          const py = r * ts + oy;
          if (tile === T.STEEL || tile === T.TREES) {
            ctx.rect(px, py, ts, ts);
          } else if (tile === T.BRICK) {
            const mask = this.brickMasks[r][c];
            if (mask & 0x1) ctx.rect(px, py, 8, 8);
            if (mask & 0x2) ctx.rect(px + 8, py, 8, 8);
            if (mask & 0x4) ctx.rect(px, py + 8, 8, 8);
            if (mask & 0x8) ctx.rect(px + 8, py + 8, 8, 8);
          }
        }
      }
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  // Animated foam where water meets land
  renderShoreline(ctx) {
    const W = MapGenerator.TILES.WATER;
    const ts = this.tileSize;
    const t = Date.now() / 1000;
    const isWater = (r, c) => r < 0 || r >= this.rows || c < 0 || c >= this.cols || this.grid[r][c] === W;
    const edge = (x0, y0, x1, y1, nx, ny) => {
      // Wavy line just inside the water edge (nx, ny points into the water)
      for (let k = 0; k <= 4; k++) {
        const f = k / 4;
        const x = x0 + (x1 - x0) * f;
        const y = y0 + (y1 - y0) * f;
        const w = 0.9 + Math.sin(t * 3 + (x + y) * 0.45) * 0.7;
        if (k === 0) ctx.moveTo(x + nx * w, y + ny * w);
        else ctx.lineTo(x + nx * w, y + ny * w);
      }
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    const [r0, r1] = this.visibleRows();
    for (let r = r0; r <= r1; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] !== W) continue;
        const x = c * ts;
        const y = r * ts;
        if (!isWater(r - 1, c)) edge(x, y, x + ts, y, 0, 1);
        if (!isWater(r + 1, c)) edge(x, y + ts, x + ts, y + ts, 0, -1);
        if (!isWater(r, c - 1)) edge(x, y, x, y + ts, 1, 0);
        if (!isWater(r, c + 1)) edge(x + ts, y, x + ts, y + ts, -1, 0);
      }
    }
    ctx.strokeStyle = `rgba(200, 235, 255, ${0.45 + Math.sin(t * 2) * 0.1})`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();
  }
}

// -------------------------------------------------------------
// INPUT BINDINGS (physical key codes: work on any keyboard layout)
// -------------------------------------------------------------
const KEY_BINDINGS = {
  // One player: every classic key drives Player I
  solo: [{
    UP: ['KeyW', 'ArrowUp'],
    DOWN: ['KeyS', 'ArrowDown'],
    LEFT: ['KeyA', 'ArrowLeft'],
    RIGHT: ['KeyD', 'ArrowRight'],
    FIRE: ['Space', 'KeyJ', 'KeyZ', 'KeyX', 'KeyK', 'Enter', 'NumpadEnter']
  }],
  // Two players share one keyboard
  duo: [{
    UP: ['KeyW'], DOWN: ['KeyS'], LEFT: ['KeyA'], RIGHT: ['KeyD'],
    FIRE: ['Space', 'KeyF', 'KeyG']
  }, {
    UP: ['ArrowUp'], DOWN: ['ArrowDown'], LEFT: ['ArrowLeft'], RIGHT: ['ArrowRight'],
    FIRE: ['Enter', 'NumpadEnter', 'Numpad0', 'ControlRight', 'ShiftRight']
  }]
};
const DIR_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const KEY_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'FIRE', 'LIGHTS'];

// Main key of every action for players I and II (changeable in SETTINGS, saved locally)
const DEFAULT_KEYMAP = {
  p1: { UP: 'KeyW', DOWN: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD', FIRE: 'Space', LIGHTS: 'KeyQ' },
  p2: { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', FIRE: 'Enter', LIGHTS: 'Period' }
};
// Extra fire keys, used while no main binding takes them
const EXTRA_FIRE = {
  p1: ['KeyF', 'KeyG'],
  p2: ['NumpadEnter', 'Numpad0', 'ControlRight', 'ShiftRight'],
  solo: ['KeyJ', 'KeyZ', 'KeyX', 'KeyK']
};

// Rebuild KEY_BINDINGS from a keymap: 'duo' = two players on one keyboard,
// 'solo' = one player who can use both sets
function applyKeyMap(keymap) {
  const used = new Set([...Object.values(keymap.p1), ...Object.values(keymap.p2)]);
  const set = (km, extra) => {
    const b = {};
    KEY_ACTIONS.forEach(a => { b[a] = [km[a]]; });
    b.FIRE = b.FIRE.concat(extra.filter(code => !used.has(code)));
    return b;
  };
  const p1 = set(keymap.p1, EXTRA_FIRE.p1);
  const p2 = set(keymap.p2, EXTRA_FIRE.p2);
  const solo = {};
  KEY_ACTIONS.forEach(a => { solo[a] = Array.from(new Set(p1[a].concat(p2[a]))); });
  solo.FIRE = solo.FIRE.concat(EXTRA_FIRE.solo.filter(code => !used.has(code)));
  KEY_BINDINGS.duo = [p1, p2];
  KEY_BINDINGS.solo = [solo];
}

// Short names of key codes for the settings screen
function keyLabel(code) {
  if (!code) return '-';
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'SPACE', Enter: 'ENTER',
    NumpadEnter: 'NUMENT', ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', ControlLeft: 'LCTRL',
    ControlRight: 'RCTRL', AltLeft: 'LALT', AltRight: 'RALT', Backspace: 'BKSP', Tab: 'TAB'
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM' + code.slice(6);
  return code.toUpperCase().slice(0, 7);
}

// Difficulty presets (applied by the host / offline game)
const DIFFICULTY = {
  easy:   { label: 'EASY',   speed: 0.85, bullet: 0.85, reaction: 1.5, lives: 5, extraOnScreen: -1 },
  normal: { label: 'NORMAL', speed: 1,    bullet: 1,    reaction: 1,   lives: 3, extraOnScreen: 0 },
  hard:   { label: 'HARD',   speed: 1.15, bullet: 1.2,  reaction: 0.7, lives: 3, extraOnScreen: 1 }
};
const DIFFICULTY_ORDER = ['easy', 'normal', 'hard'];

// Safe localStorage helpers (storage can be blocked)
function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage unavailable: keep the value for this session only
  }
}
const PLAYER_COLORS = [
  ['#ffb300', '#ffe082', '#cf8200', '#784600'], // I: gold
  ['#43c94b', '#b9f6ca', '#2a8f31', '#0f4a14'], // II: green
  ['#42a5f5', '#bbdefb', '#1e6fc2', '#0b3566'], // III: blue (big map)
  ['#ec4fa0', '#f8bbd9', '#b02a72', '#5a0f36']  // IV: pink (big map)
];
const MAX_PLAYERS = 4;
const FRIENDLY_FIRE_FREEZE = 3.0; // Classic Battle City: shooting your partner paralyses them
const FIRE_BUFFER = 0.3;          // A fire press waits this long for the previous shell to be gone
const VICTORY_DELAY = 5.0;        // Seconds the cleared field stays on screen before the tally
const DAY_LENGTH = 180;           // Conquest: seconds for a full day and night
const BOSS_PROBE = { isBoss: true, type: 'boss', y: 0 }; // Stand-in for a boss when testing a spot

// Conquest upgrades offered after each captured city (team-wide, stack up to max)
const UPGRADES = [
  { id: 'armor', icon: '🛡', label: 'ARMOR', desc: 'takes one more hit', max: 3 },
  { id: 'speed', icon: '⚡', label: 'SPEED', desc: '+10% move speed', max: 3 },
  { id: 'reload', icon: '💥', label: 'CANNON', desc: '+1 shell, faster shells', max: 2 },
  { id: 'lights', icon: '💡', label: 'LIGHTS', desc: 'reach further at night', max: 2 },
  { id: 'boat', icon: '⛵', label: 'AMPHIBIAN', desc: 'keeps the boat for good', max: 1 },
  { id: 'shield', icon: '✨', label: 'SHIELD', desc: '+3 s shield on spawn', max: 3 },
  { id: 'life', icon: '❤', label: 'LIFE', desc: '+1 life for everyone', max: 99 }
];

// Player names (online play): up to 8 letters, digits, spaces or dashes
function cleanPlayerName(name) {
  return String(name || '').toUpperCase().replace(/[^A-ZА-ЯЁ0-9 \-]/g, '').trim().slice(0, 8);
}

// Online chat: T opens the input; quick phrases on keys 1-4 or gamepad SELECT + d-pad
const CHAT_MAX = 60;          // Characters per message
const CHAT_LINE_TIME = 7000;  // ms a message stays on screen
const CHAT_LINES = 5;         // Messages shown at once
const QUICK_PHRASES = [
  { key: 'Digit1', pad: 'LEFT', text: 'HELP!' },
  { key: 'Digit2', pad: 'DOWN', text: 'COVER THE BASE!' },
  { key: 'Digit3', pad: 'UP', text: 'FOLLOW ME!' },
  { key: 'Digit4', pad: 'RIGHT', text: 'GG!' }
];

function cleanChatText(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX);
}

// -------------------------------------------------------------
// MAIN GAME CONTROLLER
// -------------------------------------------------------------
class Game {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    // Internal buffer = field size in logical px * renderScale (resized to fit the screen)
    this.renderScale = 2;
    this.layoutName = 'classic';
    this.layout = MapGenerator.LAYOUTS.classic;
    this.playerCount = 1;

    this.map = new GameMap();
    this.map.game = this;
    this.players = [];
    this.twoPlayers = false;
    this.bases = [];
    this.bullets = [];
    this.enemies = [];
    this.powerups = [];
    this.explosions = [];
    this.floatingScores = [];
    this.spawnAnimations = [];
    this.particles = [];
    this.treadMarks = [];
    this.rings = [];
    this.decals = [];          // Scorch marks & rubble (stay for the stage)
    this.parts = [];           // Wreckage pieces lying on the ground
    this.lights = [];          // Short light flashes
    this.weather = [];         // Snow / leaves / mist particles
    this.weatherKind = null;
    this.weatherFor = null;
    this.treeRustle = new Map(); // Tree tile -> seconds of shaking left
    // Conquest mode
    this.camY = 0;             // Top of the screen in world px (0 outside conquest)
    this.cities = [];
    this.turrets = [];
    this.shells = [];          // Artillery shells in flight
    this.flares = [];          // Signal flares lighting the night
    this.mines = [];
    this.extraSpawns = 0;      // Reinforcements called by scouts
    this.upgrades = {};        // Conquest upgrades picked so far
    this.upgradeChoices = null;
    this.upgradeIndex = 0;
    this.cstats = null;        // Conquest results
    this.bossSpawned = {};     // Fortress group -> boss already sent
    this.cityIdSeq = 0;
    this.worldShift = 0;
    this.distanceRows = 0;
    this.citiesCaptured = 0;
    this.gameOverText = null;
    this.screenShake = 0;
    this.treadTimer = [0, 0, 0, 0];

    this.enemyReserve = [];
    this.totalEnemiesInStage = 20;
    this.enemiesSpawned = 0;
    this.maxOnScreenEnemies = 4;
    this.spawnTimer = 0.4;
    this.spawnIndex = 0;

    this.stage = 1;
    this.stageToken = 0;
    this.hiscore = parseInt(localStorage.getItem('tank1990_hiscore') || '20000', 10);
    this.state = 'TITLE'; // TITLE, CURTAIN, PLAYING, TALLY, GAMEOVER, PAUSED
    this.isFrozen = false;
    this.freezeTimer = 0;
    this.victoryTimer = null;

    this.keys = {};
    this.dirHistory = [[], []];
    this.fireHeld = [false, false, false, false];
    this.fireAutoTimer = [0, 0, 0, 0];
    this.fireBuffer = [0, 0, 0, 0]; // Seconds a pending fire press stays remembered
    this.menuIndex = 0;
    this.tallyTimers = [];
    this.tallyReady = false;
    this.menuItems = [];
    this.menuName = 'main';

    // Online play (see net.js)
    this.net = null;
    this.online = false;
    this.remoteInputs = [];   // Host: controls of each remote player, by player index
    this.remoteTapsSeen = [];
    this.localIndex = 0;      // Which tank this computer drives
    this.playerNames = null;  // Names by player index while online
    this.playerName = cleanPlayerName(localStorage.getItem('tank1990_name')) || 'PLAYER';

    // Controls, gamepads, difficulty, records
    const savedKeys = loadJSON('tank2026_keys', null);
    this.keymap = {
      p1: Object.assign({}, DEFAULT_KEYMAP.p1, savedKeys && savedKeys.p1),
      p2: Object.assign({}, DEFAULT_KEYMAP.p2, savedKeys && savedKeys.p2)
    };
    applyKeyMap(this.keymap);
    this.awaitingKey = null;   // { player, action } while waiting for a new key
    this.pads = [];
    this.padPrev = [];
    this.localBig = false;     // Local 3-4 players on the big map (players III/IV on gamepads)
    this.difficulty = DIFFICULTY[loadJSON('tank2026_difficulty', 'normal')] ? loadJSON('tank2026_difficulty', 'normal') : 'normal';
    this.records = loadJSON('tank2026_records', []);
    // Conquest special enemies that may appear (switched in SETTINGS)
    this.enemyTypes = Object.assign({ artillery: true, miner: true, scout: true }, loadJSON('tank2026_enemies', {}));
    // Night in conquest: the cycle itself and each night rule (SETTINGS > НОЧЬ)
    this.localNightOpts = Object.assign({ cycle: true, lights: true, searchlights: true, enemies: true, ice: true, bonus: true },
      loadJSON('tank2026_night', {}));
    this.freshRecords = [];

    this.waterTimer = 0;
    this.waterFrame = 0;
    this.lastTime = 0;

    // Preload stage 1 so level preview is visible on title screen
    this.enemyReserve = this.map.loadLevel(1);
    this.createBases();
    this.createPlayers();
    this.initWeather(this.map.archetype);

    this.setupInputs();
    this.setupUI();
    this.showMenu('main');
    this.fitToScreen();
    const refit = () => { this.fitToScreen(); this.fitToScreen(); };
    window.addEventListener('resize', refit);
    document.addEventListener('fullscreenchange', refit);
    this.renderReserveIcons(false);
    this.updateHUD();
    if (!/selftest/.test(location.search)) this.startDemo();
    this.joinFromLink();
  }

  createPlayers() {
    const spawns = this.layout.playerSpawns;
    const count = Math.min(this.playerCount, spawns.length);
    this.players = [];
    for (let i = 0; i < count; i++) {
      const p = new PlayerTank(spawns[i].x * 16 + 3, spawns[i].y * 16 + 3, i);
      p.lives = DIFFICULTY[this.difficulty].lives;
      p.upgradeHook = tank => this.applyUpgrades(tank);
      this.players.push(p);
    }
  }

  // One Eagle per layout base; bunker tiles remember their Eagle
  createBases() {
    this.map.fortOwner.clear();
    this.bases = this.layout.bases.map(b => new BaseEagle(b.x * 16, b.y * 16));
    this.bases.forEach(base => base.walls.forEach(pt => this.map.fortOwner.set(pt.y * this.map.cols + pt.x, base)));
  }

  setLayout(name) {
    this.layoutName = name;
    this.layout = MapGenerator.LAYOUTS[name];
    document.getElementById('arcade-cabinet').classList.toggle('big-mode', name === 'big');
    document.getElementById('arcade-cabinet').classList.toggle('conquest-mode', name === 'conquest');
    this.fitToScreen();
  }

  nearestBase(tank) {
    let best = null;
    let bestDist = Infinity;
    for (const b of this.bases) {
      if (!b.alive) continue;
      const d = Math.hypot(b.x - tank.x, b.y - tank.y);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best || this.bases[0];
  }

  // Scale the whole playfield to the largest size that fits the window
  fitToScreen() {
    const cabinet = document.getElementById('arcade-cabinet');
    const wrapper = document.getElementById('game-wrapper');
    const header = document.getElementById('arcade-header');
    // TV / fullscreen: no cabinet frame, the game takes the whole screen
    const fullscreen = !!document.fullscreenElement ||
      (window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2);
    document.body.classList.toggle('fullscreen', fullscreen);

    // Field is 480 CSS px tall; the big map is twice as wide
    const fieldW = 480 * this.layout.cols / 26;
    document.getElementById('canvas-container').style.width = fieldW + 'px';
    this.canvas.style.width = fieldW + 'px';

    // Unscaled size of the playfield box: field + sidebar + wrapper borders
    const sidebarW = parseFloat(getComputedStyle(document.getElementById('game-sidebar')).width) || 80;
    const baseW = fieldW + sidebarW + 12;
    const baseH = 480 + 12;
    const px = el => {
      const cs = getComputedStyle(el);
      return {
        x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth),
        y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
      };
    };
    const bodyPad = px(document.body);
    const cabPad = px(cabinet);

    // Header buttons grow on big screens so they stay usable from the sofa
    const prevScale = parseFloat(wrapper.style.getPropertyValue('--ui-scale')) || 1;
    header.style.zoom = Math.max(1, Math.min(2.2, prevScale * 0.65)).toFixed(2);

    const chromeH = cabinet.getBoundingClientRect().height - wrapper.getBoundingClientRect().height - cabPad.y;
    const availW = window.innerWidth - bodyPad.x - cabPad.x - 2;
    const availH = window.innerHeight - bodyPad.y - cabPad.y - Math.max(0, chromeH) - 2;
    const scale = Math.max(0.35, Math.min(availW / baseW, availH / baseH));
    wrapper.style.setProperty('--ui-scale', scale.toFixed(3));

    // Canvas resolution follows the screen, capped so 4K TVs do not render huge buffers
    const dpr = window.devicePixelRatio || 1;
    const cols = this.layout.cols;
    const rows = this.layout.viewRows || this.layout.rows;
    let renderScale = Math.min(6, Math.max(2, Math.ceil(480 * scale * dpr / 416)));
    while (renderScale > 2 && cols * 16 * renderScale * rows * 16 * renderScale > 8e6) renderScale--;
    const bufW = cols * 16 * renderScale;
    const bufH = rows * 16 * renderScale;
    if (renderScale !== this.renderScale || this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.renderScale = renderScale;
      this.canvas.width = bufW;
      this.canvas.height = bufH;
      this.ctx.imageSmoothingEnabled = true;
    }
  }

  // -------------------------------------------------------------
  // INPUT
  // -------------------------------------------------------------
  isGuest() {
    return !!(this.online && this.net && this.net.isGuest);
  }

  getBindings(idx) {
    // Online: this keyboard drives only the local tank (Player I on host, Player II on guest)
    if (this.online) return idx === 0 ? KEY_BINDINGS.solo[0] : null;
    const set = this.twoPlayers ? KEY_BINDINGS.duo : KEY_BINDINGS.solo;
    return set[idx] || null;
  }

  getDirForCode(code, idx) {
    const b = this.getBindings(idx);
    if (!b) return null;
    return DIR_ACTIONS.find(d => b[d].includes(code)) || null;
  }

  isFireCode(code) {
    return [0, 1].some(idx => {
      const b = this.getBindings(idx);
      return b && b.FIRE.includes(code);
    });
  }

  isActionActive(action, idx = 0) {
    const b = this.getBindings(idx);
    if (!b) return false;
    if (action === 'FIRE' && idx === 0 && this.isMouseDown) return true;
    return b[action].some(code => this.keys[code]);
  }

  setupInputs() {
    const blockedDefaults = new Set(['Space', 'Enter', 'NumpadEnter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

    window.addEventListener('keydown', e => {
      sound.ensureContext();
      if (document.getElementById('modal-rules').open) return;
      if (this.awaitingKey) {
        // SETTINGS: the next key becomes the new binding (Escape cancels)
        e.preventDefault();
        if (e.code !== 'Escape') this.setKeyBinding(this.awaitingKey.player, this.awaitingKey.action, e.code);
        this.awaitingKey = null;
        this.showMenu('settings', this.menuIndex);
        return;
      }
      if (e.target && e.target.id === 'chat-input') {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') this.closeChat(true);
        else if (e.code === 'Escape') this.closeChat(false);
        return;
      }
      if (e.target && e.target.id === 'net-name') {
        if (['Enter', 'NumpadEnter', 'Escape'].includes(e.code)) e.target.blur();
        return;
      }
      if (e.target && e.target.tagName === 'INPUT') {
        // Typing a room code
        if (e.code === 'Enter' || e.code === 'NumpadEnter') this.joinOnline();
        if (e.code === 'Escape') this.showMenu('online', 2);
        return;
      }
      // Online chat: T opens the input, 1-4 send a quick phrase (unless SETTINGS gave the key an action)
      if (this.chatAvailable() && !e.repeat && this.state !== 'UPGRADE' && !this.isBoundCode(e.code)) {
        if (e.code === 'KeyT') {
          e.preventDefault(); // Or the "t" lands in the input
          this.openChat();
          return;
        }
        const phrase = QUICK_PHRASES.find(q => q.key === e.code);
        if (phrase) {
          this.sendChat(phrase.text);
          return;
        }
      }
      if (blockedDefaults.has(e.code)) e.preventDefault();
      this.keys[e.code] = true;
      if (e.repeat) return;

      // Most recently pressed direction wins (per player)
      this.dirHistory.forEach((h, idx) => {
        const d = this.getDirForCode(e.code, idx);
        if (d) {
          const i = h.indexOf(d);
          if (i !== -1) h.splice(i, 1);
          h.push(d);
        }
      });

      if (e.code === 'KeyM') this.toggleSound();

      if (this.isMenuActive()) {
        if (this.menuName === 'pause' && (e.code === 'KeyP' || e.code === 'Escape')) this.resumeFromPause();
        else this.handleMenuKey(e.code);
        return;
      }

      // Headlights on / off (night stealth)
      [0, 1].forEach(idx => {
        const b = this.getBindings(idx);
        if (b && b.LIGHTS && b.LIGHTS.includes(e.code) && this.state === 'PLAYING') this.toggleLights(idx);
        // A tap shorter than one physics step would never be seen as a held key
        if (b && b.FIRE.includes(e.code) && !e.repeat && this.state === 'PLAYING' && !this.isGuest()) this.fireBuffer[idx] = FIRE_BUFFER;
      });

      if (this.state === 'UPGRADE' && this.upgradeChoices) {
        const n = this.upgradeChoices.length;
        const digit = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].indexOf(e.code) % 3;
        if (digit >= 0 && ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].includes(e.code)) this.pickUpgrade(digit);
        else if (['ArrowLeft', 'KeyA', 'ArrowUp', 'KeyW'].includes(e.code)) this.upgradeIndex = (this.upgradeIndex + n - 1) % n;
        else if (['ArrowRight', 'KeyD', 'ArrowDown', 'KeyS'].includes(e.code)) this.upgradeIndex = (this.upgradeIndex + 1) % n;
        else if (['Enter', 'NumpadEnter', 'Space', 'KeyF', 'KeyJ'].includes(e.code)) this.pickUpgrade(this.upgradeIndex);
        return;
      }

      if (e.code === 'Escape') {
        if (this.isGuest()) this.net.send({ t: 'cmd', c: 'pause' });
        else this.togglePause();
        return;
      }

      if (this.isGuest()) {
        // Guest: commands go to the host
        if (e.code === 'KeyP') this.net.send({ t: 'cmd', c: 'pause' });
        if (this.isFireCode(e.code)) {
          if (this.state === 'TALLY') this.advanceTally();
          else this.net.taps++;
        }
        return;
      }

      if (e.code === 'KeyP') this.togglePause();
      if (e.code === 'KeyN') this.startNewRandomLevel();
      if (e.code === 'KeyR') this.restartCurrentLevel();

      if (this.state === 'TALLY' && this.isFireCode(e.code)) {
        this.advanceTally();
      }
    });

    window.addEventListener('keyup', e => {
      this.keys[e.code] = false;
      this.dirHistory.forEach((h, idx) => {
        const d = this.getDirForCode(e.code, idx);
        if (d) {
          const i = h.indexOf(d);
          if (i !== -1) h.splice(i, 1);
        }
      });
    });

    window.addEventListener('blur', () => {
      this.keys = {};
      this.dirHistory = [[], []];
      this.isMouseDown = false;
    });

    // Mouse firing support (Player I)
    this.isMouseDown = false;
    window.addEventListener('mousedown', (e) => {
      sound.ensureContext();
      if (e.target.closest('button') || e.target.closest('dialog') || e.target.closest('input')) return;
      if (e.button !== 0 && e.button !== 2) return;
      if (this.state === 'TALLY') {
        this.advanceTally();
        return;
      }
      if (this.state === 'PLAYING') {
        e.preventDefault();
        this.isMouseDown = true;
        if (this.isGuest()) this.net.taps++;
        else this.fireBuffer[0] = FIRE_BUFFER;
      }
    });
    window.addEventListener('mouseup', () => {
      this.isMouseDown = false;
    });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    // Touch controls (Player I)
    const dpadButtons = document.querySelectorAll('.dpad-btn[data-dir]');
    dpadButtons.forEach(btn => {
      const dir = btn.dataset.dir;
      const activate = (ev) => {
        ev.preventDefault();
        sound.ensureContext();
        btn.classList.add('pressed');
        this.touchDir = dir;
      };
      const deactivate = (ev) => {
        ev.preventDefault();
        btn.classList.remove('pressed');
        if (this.touchDir === dir) this.touchDir = null;
      };

      btn.addEventListener('touchstart', activate, { passive: false });
      btn.addEventListener('touchend', deactivate, { passive: false });
      btn.addEventListener('mousedown', activate);
      btn.addEventListener('mouseup', deactivate);
      btn.addEventListener('mouseleave', deactivate);
    });

    const fireBtn = document.getElementById('btn-touch-fire');
    if (fireBtn) {
      const doFire = (e) => {
        e.preventDefault();
        sound.ensureContext();
        if (this.state === 'TALLY') {
          this.advanceTally();
          return;
        }
        if (this.isGuest()) this.net.taps++;
        else this.fireBuffer[0] = FIRE_BUFFER;
      };
      fireBtn.addEventListener('touchstart', doFire, { passive: false });
      fireBtn.addEventListener('mousedown', doFire);
    }

    const pauseBtn = document.getElementById('btn-touch-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (this.isGuest()) this.net.send({ t: 'cmd', c: 'pause' });
        else this.togglePause();
      });
    }
  }

  setupUI() {
    // Player name (remembered between sessions)
    const nameInput = document.getElementById('net-name');
    nameInput.value = this.playerName;
    nameInput.addEventListener('input', () => {
      const typed = nameInput.value.toUpperCase();
      const filtered = typed.replace(/[^A-ZА-ЯЁ0-9 \-]/g, '').slice(0, 8);
      if (filtered !== typed) nameInput.value = filtered;
      this.playerName = cleanPlayerName(filtered) || 'PLAYER';
      try {
        localStorage.setItem('tank1990_name', this.playerName);
      } catch (e) {
        // Storage unavailable: keep the name for this session only
      }
    });

    // Chat input: clicking away closes it without sending
    document.getElementById('chat-input').addEventListener('blur', () => this.closeChat(false));

    // Room code: click to copy
    const codeEl = document.getElementById('net-code');
    codeEl.addEventListener('click', () => {
      if (codeEl.textContent && this.copyText(codeEl.textContent)) {
        this.setNetStatus('CODE COPIED', true);
      }
    });

    document.getElementById('btn-sound').addEventListener('click', () => {
      this.toggleSound();
    });

    document.getElementById('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());

    const crtBtn = document.getElementById('btn-crt');
    crtBtn.addEventListener('click', () => {
      const wrapper = document.getElementById('game-wrapper');
      wrapper.classList.toggle('crt-active');
      crtBtn.classList.toggle('active', wrapper.classList.contains('crt-active'));
    });

    document.getElementById('btn-seed').addEventListener('click', () => {
      if (!this.isGuest()) this.startNewRandomLevel();
    });

    const touchControls = document.getElementById('touch-controls');
    const touchBtn = document.getElementById('btn-touch-toggle');
    if (touchBtn && touchControls) {
      touchBtn.addEventListener('click', () => {
        touchControls.classList.toggle('force-visible');
        touchBtn.classList.toggle('active', touchControls.classList.contains('force-visible'));
        this.fitToScreen();
      });
    }

    // Rules modal
    const rulesModal = document.getElementById('modal-rules');
    document.getElementById('btn-howtoplay').addEventListener('click', () => {
      rulesModal.showModal();
    });
    document.getElementById('btn-close-rules').addEventListener('click', () => {
      rulesModal.close();
    });
  }

  isMenuActive() {
    return !document.getElementById('game-overlay').classList.contains('hidden');
  }

  // Title menus: [label, action] lists
  showMenu(name, selected = 0) {
    const menus = {
      main: [
        ['1 PLAYER', () => this.startNewGame(false)],
        ['2 PLAYERS', () => this.startNewGame(true)],
        ['3-4 PLAYERS', () => this.startLocalBig()],
        ['CONQUEST', () => this.showMenu('conquest')],
        ['ONLINE', () => this.showMenu('online')],
        ['SETTINGS', () => this.showMenu('settings')],
        ['RECORDS', () => this.showMenu('records')]
      ],
      conquest: [
        ['1 PLAYER', () => this.startNewGame(false, 'conquest')],
        ['2 PLAYERS', () => this.startNewGame(true, 'conquest')],
        ['3-4 PLAYERS', () => this.startLocalBig('conquest')],
        ['ONLINE HOST', () => this.hostOnline(false, true)],
        ['ONLINE HOST 4', () => this.hostOnline(true, true)],
        ['BACK', () => this.showMenu('main', 3)]
      ],
      settings: this.settingsMenuItems(),
      night: this.nightMenuItems(),
      records: [
        ['BACK', () => this.showMenu('main', 6)]
      ],
      conquestOver: [
        ['PLAY AGAIN', () => this.startNewGame(this.twoPlayers, 'conquest', this.playerCount)],
        ['MENU', () => this.leaveOnline('')]
      ],
      pause: [
        ['CONTINUE', () => this.resumeFromPause()],
        [sound.muted ? 'SOUND: OFF' : 'SOUND: ON', () => { this.toggleSound(); this.showMenu('pause', 1); }],
        ['EXIT', () => this.exitToTitle()]
      ],
      online: [
        ['HOST', () => this.hostOnline(false)],
        ['HOST 4', () => this.hostOnline(true)],
        ['JOIN', () => this.showMenu('join')],
        ['BACK', () => { this.closeNet(); this.showMenu('main', 4); }]
      ],
      lobby: [
        ['START', () => this.startBigOnline()],
        ['COPY LINK', () => this.copyRoomLink()],
        ['BACK', () => { this.closeNet(); this.showMenu('online', 1); }]
      ],
      hosting: [
        ['COPY LINK', () => this.copyRoomLink()],
        ['BACK', () => { this.closeNet(); this.showMenu('online'); }]
      ],
      join: [
        ['CONNECT', () => this.joinOnline()],
        ['BACK', () => { this.closeNet(); this.showMenu('online', 2); }]
      ],
      waiting: [
        ['BACK', () => this.exitOnline()]
      ],
      onlineOver: [
        ['PLAY AGAIN', () => this.requestRestartOnline()],
        ['EXIT', () => this.exitOnline()]
      ]
    };

    this.menuName = name;
    this.menuItems = menus[name];
    const container = document.getElementById('game-menu');
    container.innerHTML = '';
    container.classList.toggle('compact', name === 'settings' || name === 'night');
    document.getElementById('conquest-stats').classList.toggle('hidden',
      !(name === 'conquestOver' || (name === 'onlineOver' && this.layout.conquest)));
    document.getElementById('records-table').classList.toggle('hidden', name !== 'records');
    if (name === 'records') this.renderRecords();
    this.menuItems.forEach(([label, action, wide], i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-option' + (wide ? ' wide' : ''); // wide: full row in the compact settings grid
      btn.innerHTML = '<span class="menu-cursor"></span>' + label;
      btn.addEventListener('mouseenter', () => this.selectMenu(i));
      btn.addEventListener('click', () => {
        btn.blur();
        sound.ensureContext();
        action();
      });
      container.appendChild(btn);
    });
    this.selectMenu(Math.min(selected, this.menuItems.length - 1));

    // Room code panel
    const panel = document.getElementById('net-panel');
    const codeEl = document.getElementById('net-code');
    const input = document.getElementById('net-join-code');
    panel.classList.toggle('hidden', !['online', 'hosting', 'lobby', 'join', 'waiting', 'settings'].includes(name));
    document.getElementById('net-name').classList.toggle('hidden', name !== 'online' && name !== 'settings');
    document.getElementById('net-lobby').classList.toggle('hidden', !(name === 'lobby' || (name === 'waiting' && this.guestBig)));
    codeEl.classList.toggle('hidden', name !== 'hosting' && name !== 'lobby');
    input.classList.toggle('hidden', name !== 'join');
    if (name === 'join') {
      input.value = '';
      setTimeout(() => input.focus(), 0);
    } else {
      input.blur();
    }
    if (name === 'main' || name === 'online' || name === 'join' || name === 'records') this.setNetStatus('');
    if (name === 'settings') {
      const n = this.pads.length;
      this.setNetStatus(this.awaitingKey ? 'PRESS A KEY' : (n ? 'GAMEPADS: ' + n : 'NO GAMEPAD FOUND'), !!this.awaitingKey);
    }
  }

  // SETTINGS: difficulty, then the keys of players I and II side by side
  settingsMenuItems() {
    const items = [['DIFFICULTY: ' + DIFFICULTY[this.difficulty].label, () => this.cycleDifficulty(), true]];
    // Conquest special enemies on / off
    [['artillery', 'ARTILLERY'], ['miner', 'MINERS'], ['scout', 'SCOUTS']].forEach(([type, label], k) => {
      items.push([label + ': ' + (this.enemyTypes[type] ? 'ON' : 'OFF'), () => {
        this.enemyTypes[type] = !this.enemyTypes[type];
        saveJSON('tank2026_enemies', this.enemyTypes);
        this.showMenu('settings', this.menuIndex);
      }, k === 2]);
    });
    KEY_ACTIONS.forEach(action => {
      ['p1', 'p2'].forEach(player => {
        const waiting = this.awaitingKey && this.awaitingKey.player === player && this.awaitingKey.action === action;
        const label = (player === 'p1' ? 'I ' : 'II ') + action + ': ' + (waiting ? '...' : keyLabel(this.keymap[player][action]));
        items.push([label, () => {
          this.awaitingKey = { player, action };
          this.showMenu('settings', this.menuIndex);
        }]);
      });
    });
    items.push(['NIGHT...', () => this.showMenu('night'), true]);
    items.push(['RESET KEYS', () => {
      this.keymap = { p1: Object.assign({}, DEFAULT_KEYMAP.p1), p2: Object.assign({}, DEFAULT_KEYMAP.p2) };
      applyKeyMap(this.keymap);
      saveJSON('tank2026_keys', this.keymap);
      this.showMenu('settings', this.menuIndex);
    }, true]);
    items.push(['BACK', () => this.showMenu('main', 5), true]);
    return items;
  }

  // SETTINGS > НОЧЬ: day/night cycle and every night rule on or off
  nightMenuItems() {
    const opts = this.localNightOpts;
    const rows = [
      ['cycle', 'DAY & NIGHT'], ['lights', 'LIGHTS & STEALTH'], ['searchlights', 'SEARCHLIGHTS'],
      ['enemies', 'NIGHT RAIDERS'], ['ice', 'FROZEN WATER'], ['bonus', 'NIGHT BONUS']
    ];
    const items = rows.map(([key, label], i) => [label + ': ' + (opts[key] ? 'ON' : 'OFF'), () => {
      opts[key] = !opts[key];
      saveJSON('tank2026_night', opts);
      this.showMenu('night', i);
    }, true]);
    items.push(['BACK', () => this.showMenu('settings', 4), true]);
    return items;
  }

  // New key for an action; if another action used that key, the two swap
  setKeyBinding(player, action, code) {
    const old = this.keymap[player][action];
    ['p1', 'p2'].forEach(p => KEY_ACTIONS.forEach(a => {
      if (this.keymap[p][a] === code) this.keymap[p][a] = old;
    }));
    this.keymap[player][action] = code;
    applyKeyMap(this.keymap);
    saveJSON('tank2026_keys', this.keymap);
  }

  cycleDifficulty() {
    const i = DIFFICULTY_ORDER.indexOf(this.difficulty);
    this.difficulty = DIFFICULTY_ORDER[(i + 1) % DIFFICULTY_ORDER.length];
    saveJSON('tank2026_difficulty', this.difficulty);
    this.showMenu('settings', 0);
  }

  // Local 3-4 players on the big map: I and II on the keyboard, III and IV on gamepads
  startLocalBig(layoutName = 'big') {
    const pads = this.pads.length;
    if (pads === 0) {
      this.setNetStatus('CONNECT A GAMEPAD');
      return;
    }
    this.startNewGame(true, layoutName, 2 + Math.min(2, pads));
  }

  // -------------------------------------------------------------
  // PAUSE MENU (opens on every computer while the game state is PAUSED)
  // -------------------------------------------------------------
  syncPauseMenu() {
    const paused = this.state === 'PAUSED';
    if (paused && this.menuName !== 'pause') {
      this.setLogo('PAUSE', '');
      document.getElementById('game-overlay').classList.add('pause-mode');
      this.showMenu('pause');
      document.getElementById('game-overlay').classList.remove('hidden');
    } else if (!paused && this.menuName === 'pause') {
      this.menuName = 'none';
      document.getElementById('game-overlay').classList.add('hidden');
      document.getElementById('game-overlay').classList.remove('pause-mode');
      this.setLogo('TANK', '2026');
    }
  }

  resumeFromPause() {
    if (this.isGuest()) this.net.send({ t: 'cmd', c: 'pause' });
    else this.togglePause();
  }

  exitToTitle() {
    if (this.state !== 'TITLE' && this.state !== 'GAMEOVER') this.recordScores();
    document.getElementById('game-overlay').classList.remove('pause-mode');
    this.leaveOnline('');
  }

  // -------------------------------------------------------------
  // RECORDS: top 10 scores with names, kept in this browser
  // -------------------------------------------------------------
  recordScores() {
    if (this.demo) return;
    this.freshRecords = [];
    const names = this.online ? this.playerNames : null;
    this.players.forEach((p, i) => {
      if (!p || p.score <= 0) return;
      const name = (names && names[i]) || (i === 0 ? this.playerName : this.defaultName(i));
      const entry = {
        name, score: p.score, stage: this.stage, id: Date.now() + '-' + i,
        label: this.layout.conquest ? 'CITY ' + this.citiesCaptured : 'ST ' + this.stage
      };
      this.records.push(entry);
      this.freshRecords.push(entry.id);
    });
    this.records.sort((a, b) => b.score - a.score);
    this.records = this.records.slice(0, 10);
    saveJSON('tank2026_records', this.records);
  }

  renderRecords() {
    const el = document.getElementById('records-table');
    el.innerHTML = '';
    if (!this.records.length) {
      el.textContent = 'NO RECORDS YET';
      return;
    }
    this.records.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'record-row' + (this.freshRecords.includes(r.id) ? ' fresh' : '');
      [String(i + 1) + '.', cleanPlayerName(r.name) || '-', String(r.score), String(r.label || 'ST ' + r.stage).slice(0, 8)].forEach((text, k) => {
        const cell = document.createElement('span');
        cell.className = 'rc' + k;
        cell.textContent = text;
        row.appendChild(cell);
      });
      el.appendChild(row);
    });
  }

  selectMenu(index) {
    this.menuIndex = index;
    Array.from(document.querySelectorAll('#game-menu .menu-option'))
      .forEach((o, i) => o.classList.toggle('selected', i === index));
  }

  handleMenuKey(code) {
    const n = this.menuItems.length;
    if (['KeyW', 'ArrowUp'].includes(code) && n > 1) {
      this.selectMenu((this.menuIndex + n - 1) % n);
      sound.playTallyBeep();
    } else if (['KeyS', 'ArrowDown'].includes(code) && n > 1) {
      this.selectMenu((this.menuIndex + 1) % n);
      sound.playTallyBeep();
    } else if (['Enter', 'NumpadEnter', 'Space', 'KeyJ', 'KeyF'].includes(code)) {
      this.menuItems[this.menuIndex][1]();
    } else if (code === 'Escape') {
      const back = this.menuItems.find(([label]) => label === 'BACK');
      if (back) back[1]();
    }
  }

  setLogo(top, bottom) {
    const lines = document.querySelectorAll('#game-overlay .logo-line');
    lines[0].textContent = top;
    lines[1].textContent = bottom;
  }

  setNetStatus(text, waiting = false) {
    const el = document.querySelector('#game-overlay .sub-title');
    el.textContent = text;
    el.classList.toggle('net-wait', waiting);
  }

  // Whole screen for TVs (Esc or the button again leaves it)
  toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  toggleSound() {
    if (this.demo) {
      // The demo keeps the sound off; remember the choice for the real game
      this.demoSavedMute = !this.demoSavedMute;
      document.getElementById('btn-sound').innerHTML = '<span class="btn-icon">' + (this.demoSavedMute ? '🔇' : '🔊') + '</span>';
      return;
    }
    const isUnmuted = sound.toggleMute();
    document.getElementById('btn-sound').innerHTML = '<span class="btn-icon">' + (isUnmuted ? '🔊' : '🔇') + '</span>';
  }

  togglePause() {
    if (this.state === 'PLAYING') {
      this.state = 'PAUSED';
      sound.stopEngineHum();
    } else if (this.state === 'PAUSED') {
      this.state = 'PLAYING';
    }
  }

  // -------------------------------------------------------------
  // GAME FLOW
  // -------------------------------------------------------------
  // layoutName 'big' = wide map with two Eagles; playerCount defaults to 1 or 2
  startNewGame(twoPlayers = this.twoPlayers, layoutName = 'classic', playerCount = null) {
    this.stopDemo();
    this.twoPlayers = twoPlayers;
    this.playerCount = playerCount || (twoPlayers ? 2 : 1);
    this.localBig = !this.online && this.playerCount > 2; // III/IV on gamepads
    this.upgrades = {};
    document.getElementById('arcade-cabinet').classList.toggle('two-players', this.playerCount > 1);
    this.setLayout(layoutName);
    // Compact sidebar with four player blocks: big map, or three-four players anywhere
    document.getElementById('arcade-cabinet').classList.toggle('big-mode', layoutName === 'big' || this.playerCount > 2);
    this.fitToScreen(); // The four-player sidebar is wider
    this.stage = 1;
    this.gameOverText = null;
    this.createPlayers();
    this.dirHistory = [[], []];
    this.fireHeld = [false, false, false, false];
    this.fireBuffer = [0, 0, 0, 0];
    document.getElementById('game-overlay').classList.add('hidden');
    // Ensure every game start produces a brand new randomized battlefield
    this.startStage(this.stage, Math.floor(Math.random() * 9999999));
  }

  startNewRandomLevel() {
    if (this.state === 'TITLE' || this.state === 'GAMEOVER' || this.isGuest()) return;
    sound.ensureContext();
    document.getElementById('tally-screen').classList.add('hidden');
    // Fresh random seed
    this.startStage(this.stage, Math.floor(Math.random() * 9999999));
  }

  restartCurrentLevel() {
    if (this.state === 'TITLE' || this.state === 'GAMEOVER') return;
    document.getElementById('tally-screen').classList.add('hidden');
    this.startStage(this.stage, Math.floor(Math.random() * 9999999));
  }

  startStage(stageNumber, customSeed = null) {
    this.stage = stageNumber;
    this.state = 'CURTAIN';
    const token = ++this.stageToken;
    sound.stopEngineHum();
    this.clearTallyTimers();

    // Load new procedural map
    this.enemyReserve = this.map.loadLevel(this.stage, customSeed, this.layoutName);
    this.totalEnemiesInStage = this.enemyReserve.length;
    this.maxOnScreenEnemies = Math.max(2, this.layout.maxOnScreen + DIFFICULTY[this.difficulty].extraOnScreen);
    this.enemiesSpawned = 0;
    this.spawnIndex = 0;
    this.spawnTimer = 0.3;

    // Show stage curtain (halves close, then open)
    const curtain = this.showStageCurtain(this.stage);
    this.netUi('stage', { stage: this.stage });

    // Reset entities
    this.bullets = [];
    this.enemies = [];
    this.powerups = [];
    this.explosions = [];
    this.floatingScores = [];
    this.spawnAnimations = [];
    this.treadMarks = [];
    this.rings = [];
    this.decals = [];
    this.parts = [];
    this.lights = [];
    this.treeRustle.clear();
    this.weatherFor = null;
    this.isFrozen = false;
    this.freezeTimer = 0;
    this.victoryTimer = null;

    // Create the Eagle(s)
    this.createBases();
    if (this.layout.conquest) this.initConquest();
    else {
      this.camY = 0;
      this.cities = [];
      this.turrets = [];
    }

    // Players with lives left return to their spawn points
    this.players.forEach(p => {
      p.resetKills();
      // Survivors keep their weapon into the next stage; a tank destroyed at the very end does not
      if (p.lives > 0) p.respawn(!p.dead);
      else p.dead = true;
    });

    this.renderReserveIcons(false);
    this.updateHUD();

    let dismissed = false;
    const dismissCurtain = () => {
      if (dismissed) return;
      dismissed = true;
      curtain.removeEventListener('click', dismissCurtain);
      if (token !== this.stageToken) return;
      this.openStageCurtain();
      this.netUi('open');
      this.state = 'PLAYING';
      this.players.forEach(p => {
        if (!p.dead) this.spawnRing(p.x + 13, p.y + 13, PLAYER_COLORS[p.index][0], 26, 0.6);
      });
    };
    curtain.addEventListener('click', dismissCurtain);

    // Play stage intro theme
    sound.playStageStart(() => {
      dismissCurtain();
    });
  }

  showStageCurtain(stage) {
    const curtain = document.getElementById('stage-screen');
    document.querySelector('#stage-screen .stage-text').innerHTML =
      this.layout.conquest ? 'CONQUEST' : 'STAGE <span id="stage-num-curtain">' + stage + '</span>';
    curtain.classList.remove('opening');
    curtain.classList.remove('hidden');
    return curtain;
  }

  openStageCurtain() {
    const token = this.stageToken;
    const curtain = document.getElementById('stage-screen');
    curtain.classList.add('opening');
    setTimeout(() => {
      if (token !== this.stageToken) return;
      curtain.classList.add('hidden');
      curtain.classList.remove('opening');
    }, 500);
  }

  nextStage() {
    document.getElementById('tally-screen').classList.add('hidden');
    this.startStage(this.stage + 1);
  }

  renderReserveIcons(animate = true, remainingCount = null) {
    const container = document.getElementById('enemy-reserve-icons');
    const iconCount = this.layout.totalEnemies;
    if (container.children.length !== iconCount) {
      container.innerHTML = '';
      for (let i = 0; i < iconCount; i++) {
        const icon = document.createElement('div');
        icon.id = 'reserve-icon-' + i;
        container.appendChild(icon);
      }
    }
    const remaining = remainingCount !== null ? remainingCount : this.enemyReserve.length + this.enemies.length;
    Array.from(container.children).forEach((icon, i) => {
      if (i < remaining) {
        icon.className = 'enemy-icon active';
      } else if (!icon.classList.contains('killed')) {
        const wasActive = icon.classList.contains('active');
        icon.className = 'enemy-icon killed' + (animate && wasActive ? ' vanish' : '');
      }
    });
  }

  setHudText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = String(value);
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('bump');
    void el.offsetWidth; // restart CSS animation
    el.classList.add('bump');
  }

  updateHUD() {
    const big = this.layoutName === 'big' || this.players.length > 2;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.players[i];
      const n = i + 1;
      // On the big map only the blocks of players in the game are shown
      document.getElementById('p' + n + '-block').classList.toggle('absent', big && !p);
      this.setHudText('p' + n + '-lives', p ? Math.max(0, p.lives) : 0);
      const score = String(p ? p.score : 0).padStart(6, '0');
      if (i < 2) this.setHudText(i === 0 ? 'hud-score' : 'hud-score2', score);
      this.setHudText('p' + n + '-pscore', score);

      // Weapon Stars upgrade level indicator (★ / ★★ / ★★★)
      const tier = p ? p.tier : 1;
      for (let s = 1; s <= 3; s++) {
        const el = document.getElementById('p' + n + '-star-' + s);
        if (el) el.classList.toggle('active', tier >= s + 1);
      }
    }

    // Names replace IP / IIP / IIIP / IVP while playing online
    const names = this.online ? this.playerNames : null;
    ['IP', 'IIP', 'IIIP', 'IVP'].forEach((fallback, i) => {
      const el = document.getElementById('p' + (i + 1) + '-label');
      const text = (names && names[i]) || fallback;
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('name', !!(names && names[i]));
    });

    if (this.layout.conquest) {
      this.setHudText('stage-number', this.citiesCaptured); // Flag = captured cities
      this.setHudText('hud-distance', this.distanceRows);
    } else {
      this.setHudText('stage-number', this.stage);
    }
    const best = Math.max(0, ...this.players.map(p => p.score));
    this.setHudText('hud-hiscore', String(Math.max(best, this.hiscore)).padStart(6, '0'));
    document.getElementById('menu-hiscore').textContent = String(this.hiscore);

    // Active power-up badges
    const anyBoat = this.players.some(p => p.hasBoat && !p.dead);
    document.getElementById('badge-boat').classList.toggle('hidden', !anyBoat);
    document.getElementById('badge-shovel').classList.toggle('hidden', !this.bases.some(b => b.shovelTimer > 0));
    document.getElementById('badge-clock').classList.toggle('hidden', !this.isFrozen);
  }

  addScore(pts, x = null, y = null, player = null) {
    if (player) player.score += pts;
    const best = Math.max(0, ...this.players.map(p => p.score));
    if (best > this.hiscore && !this.demo) {
      this.hiscore = best;
      localStorage.setItem('tank1990_hiscore', this.hiscore);
    }
    if (x !== null && y !== null) {
      this.floatingScores.push(new FloatingScore(x, y, pts));
    }
    this.updateHUD();
  }

  nearestAlivePlayer(tank) {
    let best = null;
    let bestDist = Infinity;
    for (const p of this.players) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - tank.x, p.y - tank.y);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  // -------------------------------------------------------------
  // UPDATE LOOP
  // -------------------------------------------------------------
  update(dt) {
    // Screen shake decay
    if (this.screenShake > 0) {
      this.screenShake = Math.max(0, this.screenShake - dt * 14);
    }

    // Update Particles (brick debris, ricochet sparks, smoke)
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.drag) {
        const f = Math.max(0, 1 - p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      if (p.isSmoke) {
        p.size += dt * (p.grow || 5);
      }
      if (p.isRipple) {
        p.size += dt * 14;
      }
      if (p.isLeaf) {
        p.rot += p.vr * dt;
        p.x += Math.sin(p.rot) * p.sway * dt; // tumble side to side
      }
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // Update Tread Marks (fade out over time)
    for (let i = this.treadMarks.length - 1; i >= 0; i--) {
      const tm = this.treadMarks[i];
      tm.life -= dt;
      if (tm.life <= 0) {
        this.treadMarks.splice(i, 1);
      }
    }

    if (this.state !== 'PAUSED') {
      // Shockwave rings
      for (let i = this.rings.length - 1; i >= 0; i--) {
        this.rings[i].t += dt;
        if (this.rings[i].t >= this.rings[i].dur) this.rings.splice(i, 1);
      }

      // Explosions & float scores keep animating after the action stops
      this.explosions.forEach(e => e.update(dt));
      this.explosions = this.explosions.filter(e => !e.dead);
      this.floatingScores.forEach(fs => fs.update(dt));
      this.floatingScores = this.floatingScores.filter(fs => !fs.dead);

      // Ruined Eagles keep smouldering
      this.bases.forEach(base => {
        if (!base.alive && Math.random() < dt * 8) this.addSmokeParticle(base.x + 16, base.y + 12, true);
      });

      // Signal flares burn down
      for (let i = this.flares.length - 1; i >= 0; i--) {
        this.flares[i].t += dt;
        if (this.flares[i].t >= this.flares[i].dur) this.flares.splice(i, 1);
      }

      // Light flashes, weather, rustling trees and damage effects
      for (let i = this.lights.length - 1; i >= 0; i--) {
        this.lights[i].t += dt;
        if (this.lights[i].t >= this.lights[i].duration) this.lights.splice(i, 1);
      }
      this.updateWeather(dt);
      this.updateLivingWorld(dt);
      this.updateParts(dt);

      // GAME OVER text rises from the bottom of the screen
      if (this.gameOverText) {
        this.gameOverText.y = Math.max(this.gameOverText.target, this.gameOverText.y - dt * 160);
      }
    }

    if (this.isGuest()) {
      this.updateGuest(dt);
      return;
    }

    if (this.state !== 'PLAYING') return;

    // Smooth looping water animation
    this.waterTimer += dt;
    if (this.waterTimer >= 0.14) {
      this.waterFrame = (this.waterFrame + 1) % Sprites.WATER_FRAMES;
      this.waterTimer = 0;
    }

    // Freeze timer (Clock bonus)
    if (this.isFrozen) {
      this.freezeTimer -= dt;
      if (this.freezeTimer <= 0) {
        this.isFrozen = false;
        this.updateHUD();
      }
    }

    // Base update (shovel fortify timer)
    this.bases.forEach(base => base.update(dt, this.map));

    // Player controls & update
    let anyActive = false;
    let anyMoving = false;
    this.players.forEach((p, idx) => {
      if (p.dead) {
        if (this.online && idx >= 1 && this.remoteInputs[idx]) this.remoteTapsSeen[idx] = this.remoteInputs[idx].taps;
        if (p.lives > 0 && p.respawnTimer > 0) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) {
            if (this.layout.conquest) this.findRespawnSpot(p);
            p.respawn();
            this.applyRespawnUpgrades(p);
            this.spawnRing(p.x + 13, p.y + 13, PLAYER_COLORS[p.index][0], 26, 0.6);
            this.updateHUD();
          }
        }
        return;
      }

      this.handlePlayerInput(p, idx, dt);
      p.update(dt, this.map);
      if (p.revealTimer > 0) p.revealTimer -= dt;
      if (p.frozenTimer <= 0) {
        anyActive = true;
        if (p.moving) anyMoving = true;
      }
      if (p.moving) {
        this.treadTimer[idx] += dt;
        if (this.treadTimer[idx] > 0.12) {
          this.treadTimer[idx] = 0;
          this.recordTreadMark(p);
          if (Math.random() < 0.25) this.spawnSmokePuff(p.x + 14, p.y + 14);
        }
      }
    });
    if (anyActive) sound.setEngineState(anyMoving, true);

    // Spawn enemy tanks
    if (this.layout.conquest) {
      this.dayTime += dt;
      if (this.cstats) this.cstats.time += dt;
      const before = this.distanceRows;
      this.updateCamera(dt);
      if (this.distanceRows !== before) this.updateHUD();
      this.handleConquestSpawning(dt);
      this.updateCities(dt);
      this.updateTurrets(dt);
      this.updateCapturedCities(dt);
      this.updateSpecialEnemies(dt);
      this.updateNightRules(dt);
    } else {
      this.handleEnemySpawning(dt);
    }

    // Update spawn star animations
    for (let i = this.spawnAnimations.length - 1; i >= 0; i--) {
      const sa = this.spawnAnimations[i];
      sa.timer -= dt;
      const saSize = sa.big ? 52 : 26;
      if (sa.timer <= 0 && this.map.isBlocked(sa.x, sa.y, saSize, saSize, false, sa.big ? BOSS_PROBE : null, true)) {
        sa.timer = 0.3; // A tank is standing on the spawn point: wait instead of spawning inside it
      } else if (sa.timer <= 0) {
        // Spawn actual tank now
        const enemy = new EnemyTank(sa.x, sa.y, sa.config);
        const diff = DIFFICULTY[this.difficulty];
        enemy.speed *= diff.speed;
        enemy.bulletSpeed *= diff.bullet;
        enemy.reaction = diff.reaction;
        if (enemy.isBoss) this.crushBricks(enemy);
        if (sa.homeCity) {
          enemy.homeCity = sa.homeCity;
          const city = this.cities.find(c => c.id === sa.homeCity);
          if (city) {
            // Guards patrol their city and close in on intruders (see EnemyTank.pickNewDirection)
            enemy.guard = { x: city.zone.x, y: city.zone.y, w: city.zone.w, h: city.zone.h, cx: city.x + 16, cy: city.y + 16 };
            enemy.reaction = (enemy.reaction || 1) * 0.8;
          }
        }
        this.enemies.push(enemy);
        this.spawnAnimations.splice(i, 1);
        this.spawnRing(sa.x + 13, sa.y + 13, '#ffffff', 18, 0.3);
      }
    }

    // Update enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (this.layout.conquest && enemy.y + 26 < this.camY) enemy.shootTimer = Math.max(enemy.shootTimer, 0.4); // No shots from off-screen
      const bullet = enemy.update(dt, this.map, this.nearestTarget(enemy), this.nearestBase(enemy), this.isFrozen);
      if (enemy.moving && Math.random() < 0.035) {
        this.recordTreadMark(enemy);
      }
      this.addBullet(bullet);

      // Check enemy picking up powerups (Classic Tank 1990 feature!)
      for (let p = this.powerups.length - 1; p >= 0; p--) {
        const pu = this.powerups[p];
        if (enemy.collidesWith(pu)) {
          this.applyEnemyPowerup(enemy, pu.type);
          pu.dead = true;
          this.powerups.splice(p, 1);
        }
      }
    }

    // Tanks that ended up inside a wall or another tank are pushed out
    this.players.concat(this.enemies).forEach(t => { if (!t.dead) this.unstickTank(t); });
    // An enemy shut in a pocket of steel or water can never be reached: it blows up (no points)
    this.trapCheck = (this.trapCheck || 0) - dt;
    if (this.trapCheck <= 0) {
      this.trapCheck = 1;
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        if (e.isBoss || e.hasBoat || !this.map.isEnclosed(e.x, e.y)) {
          e.trapped = 0;
          continue;
        }
        e.trapped = (e.trapped || 0) + 1;
        if (e.trapped < 2) continue;
        this.explosions.push(new ExplosionEffect(e.x + 14, e.y + 14, true));
        this.spawnTankDebris(e.x + 14, e.y + 14, ['#78909c', '#b0bec5', '#455a64']);
        sound.playExplosion(true);
        this.enemies.splice(i, 1);
        this.renderReserveIcons();
      }
    }

    // Update bullets & collision detection
    this.updateBullets(dt);

    // Update power-up items
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.update(dt);
      if (pu.dead) {
        this.powerups.splice(i, 1);
        continue;
      }

      // Check player collection
      const collector = this.players.find(p => !p.dead && p.collidesWith(pu));
      if (collector) {
        this.applyPlayerPowerup(collector, pu.type);
        pu.dead = true;
        this.powerups.splice(i, 1);
      }
    }

    // Check Victory condition: all enemy tanks destroyed!
    // The field stays on screen for a few seconds before the tally (players can still drive
    // and pick up bonuses); leftover enemy shells fizzle out so the win cannot be lost
    if (!this.layout.conquest && this.enemyReserve.length === 0 && this.enemies.length === 0 && this.spawnAnimations.length === 0) {
      if (this.victoryTimer === null) {
        this.victoryTimer = VICTORY_DELAY;
        for (let i = this.bullets.length - 1; i >= 0; i--) {
          const b = this.bullets[i];
          if (b.owner !== 'enemy') continue;
          this.spawnRicochetSparks(b.x + 3, b.y + 3);
          this.removeBullet(i);
        }
      }
      this.victoryTimer -= dt;
      if (this.victoryTimer <= 0) {
        this.victoryTimer = null;
        this.triggerStageComplete();
      }
      return;
    }

    // Check Defeat condition: any Eagle destroyed or every player out of lives
    const allOut = this.players.every(p => p.dead && p.lives <= 0);
    if (this.bases.some(b => !b.alive) || allOut) {
      this.triggerGameOver();
    }
  }

  // Current controls of a player: { dir, fire, tap }
  readInput(idx) {
    if (this.demo) return this.demoInput(idx);
    if (this.online && idx >= 1) {
      // Remote guest driving this tank
      const r = this.remoteInputs[idx];
      if (!r) return { dir: null, fire: false, tap: false };
      if (this.remoteTapsSeen[idx] === undefined) this.remoteTapsSeen[idx] = r.taps;
      const tap = r.taps !== this.remoteTapsSeen[idx];
      this.remoteTapsSeen[idx] = r.taps;
      return { dir: r.dir, fire: r.fire, tap };
    }

    // Prioritize most recently pressed direction from history stack
    let dir = null;
    const history = this.dirHistory[idx] || []; // Only local players have key bindings
    for (let i = history.length - 1; i >= 0; i--) {
      if (this.isActionActive(history[i], idx)) {
        dir = history[i];
        break;
      }
    }
    if (!dir) {
      dir = DIR_ACTIONS.find(d => this.isActionActive(d, idx)) || null;
    }
    if (idx === 0 && this.touchDir) dir = this.touchDir;
    let fire = this.isActionActive('FIRE', idx);
    let tap = false;
    const pad = this.padForPlayer(idx);
    if (pad) {
      if (!dir && !(pad.chat && this.chatAvailable())) dir = pad.dir;
      fire = fire || pad.fire;
      tap = pad.firePressed;
      pad.firePressed = false; // A press fires once even if several physics steps run this frame
    }
    return { dir, fire, tap };
  }

  // -------------------------------------------------------------
  // TITLE DEMO: two bots play a silent classic stage behind the menu
  // -------------------------------------------------------------
  startDemo() {
    if (this.online || this.net) return;
    if (!this.demo) this.demoSavedMute = sound.muted;
    this.demo = true;
    sound.muted = true;
    sound.stopEngineHum();
    this.demoBot = [{}, {}];
    this.twoPlayers = true;
    this.playerCount = 2;
    this.localBig = false;
    this.setLayout('classic');
    this.createPlayers();
    this.startStage(1 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 9999999));
    document.getElementById('stage-screen').classList.add('hidden');
    this.state = 'PLAYING';
    document.getElementById('game-overlay').classList.add('demo-mode');
  }

  stopDemo() {
    if (!this.demo) return;
    this.demo = false;
    sound.muted = this.demoSavedMute;
    clearTimeout(this.demoRestart);
    this.stageToken++; // The demo stage's curtain callback must not start a real game behind the menu
    document.getElementById('game-overlay').classList.remove('demo-mode');
    this.enemies = [];
    this.bullets = [];
    this.spawnAnimations = [];
    this.state = 'TITLE';
  }

  // Next demo round shortly after this one ended
  restartDemo() {
    this.state = 'TITLE';
    clearTimeout(this.demoRestart);
    this.demoRestart = setTimeout(() => { if (this.demo) this.startDemo(); }, 1500);
  }

  // Bot driver: line up with the nearest enemy and shoot, wander a little
  demoInput(idx) {
    const p = this.players[idx];
    const bot = this.demoBot[idx] || (this.demoBot[idx] = {});
    if (!p || p.dead) return { dir: null, fire: false, tap: false };
    p.shieldTimer = Math.max(p.shieldTimer, 1); // Bots do not die: the demo keeps going
    let target = null;
    let best = Infinity;
    this.enemies.forEach(e => {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < best) { best = d; target = e; }
    });
    bot.timer = (bot.timer || 0) - 1 / 60;
    if (bot.timer <= 0 || !bot.dir) {
      bot.timer = 0.4 + Math.random() * 0.8;
      if (target) {
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        if (Math.abs(dx) < 8) bot.dir = dy < 0 ? 'UP' : 'DOWN';
        else if (Math.abs(dy) < 8) bot.dir = dx < 0 ? 'LEFT' : 'RIGHT';
        else bot.dir = Math.abs(dx) < Math.abs(dy) ? (dx < 0 ? 'LEFT' : 'RIGHT') : (dy < 0 ? 'UP' : 'DOWN');
      }
      if (!target || Math.random() < 0.2) bot.dir = DIR_ACTIONS[Math.floor(Math.random() * 4)];
    }
    return { dir: bot.dir, fire: Math.random() < 0.6, tap: false };
  }

  // -------------------------------------------------------------
  // GAMEPADS (standard mapping: d-pad / left stick, A B X Y RB RT = fire, Start = pause)
  // -------------------------------------------------------------
  pollGamepads() {
    const list = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(p => p && p.connected) : [];
    this.pads = list.map((gp, i) => {
      const prev = this.padPrev[i] || {};
      const btn = n => !!(gp.buttons[n] && gp.buttons[n].pressed);
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      let dir = null;
      if (btn(12)) dir = 'UP';
      else if (btn(13)) dir = 'DOWN';
      else if (btn(14)) dir = 'LEFT';
      else if (btn(15)) dir = 'RIGHT';
      else if (Math.max(Math.abs(ax), Math.abs(ay)) > 0.5) {
        dir = Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? 'LEFT' : 'RIGHT') : (ay < 0 ? 'UP' : 'DOWN');
      }
      const fire = btn(0) || btn(1) || btn(2) || btn(3) || btn(5) || btn(7);
      const confirm = btn(0);
      const back = btn(1);
      const start = btn(9);
      const lights = btn(4);
      const chat = btn(8); // SELECT / VIEW: held for quick chat phrases
      return {
        dir, fire, confirm, back, start, lights, chat,
        lightsPressed: lights && !prev.lights,
        firePressed: fire && !prev.fire,
        confirmPressed: confirm && !prev.confirm,
        backPressed: back && !prev.back,
        startPressed: start && !prev.start,
        dirPressed: dir && dir !== prev.dir ? dir : null
      };
    });
    this.padPrev = this.pads.map(p => ({ dir: p.dir, fire: p.fire, confirm: p.confirm, back: p.back, start: p.start, lights: p.lights }));
    this.handlePadUI();
  }

  // Which gamepad drives a tank: online -> the first pad drives this computer's tank;
  // local 3-4 players -> pads 1-2 drive players III-IV (I and II have the keyboard), pads 3-4 join I and II;
  // otherwise pad N drives player N
  padForPlayer(idx) {
    if (this.online) return idx === 0 ? this.pads[0] || null : null;
    if (this.localBig) return (idx >= 2 ? this.pads[idx - 2] : this.pads[idx + 2]) || null;
    return this.pads[idx] || null;
  }

  // Inverse of padForPlayer
  playerForPad(i) {
    if (this.online) return 0;
    if (this.localBig) return i < 2 ? i + 2 : i - 2;
    return i;
  }

  // Menus, pause and tally can be driven from any gamepad
  handlePadUI() {
    if (this.awaitingKey) return;
    this.pads.forEach((pad, i) => {
      // Online: SELECT held + d-pad sends a quick phrase instead of moving
      if (pad.chat && this.chatAvailable()) {
        const phrase = pad.dirPressed && QUICK_PHRASES.find(q => q.pad === pad.dirPressed);
        if (phrase) this.sendChat(phrase.text);
        pad.firePressed = false;
        return;
      }
      if (this.state === 'UPGRADE' && this.upgradeChoices) {
        const n = this.upgradeChoices.length;
        if (pad.dirPressed === 'LEFT' || pad.dirPressed === 'UP') this.upgradeIndex = (this.upgradeIndex + n - 1) % n;
        if (pad.dirPressed === 'RIGHT' || pad.dirPressed === 'DOWN') this.upgradeIndex = (this.upgradeIndex + 1) % n;
        if (pad.confirmPressed) this.pickUpgrade(this.upgradeIndex);
        pad.firePressed = false;
        return;
      }
      if (this.isMenuActive()) {
        if (pad.dirPressed === 'UP') this.handleMenuKey('ArrowUp');
        else if (pad.dirPressed === 'DOWN') this.handleMenuKey('ArrowDown');
        if (pad.confirmPressed) this.handleMenuKey('Enter');
        else if (pad.backPressed) this.handleMenuKey('Escape');
        if (pad.startPressed && this.menuName === 'pause') this.resumeFromPause();
        pad.firePressed = false;
        return;
      }
      if (pad.startPressed) {
        if (this.isGuest()) this.net.send({ t: 'cmd', c: 'pause' });
        else this.togglePause();
      }
      if (pad.lightsPressed && this.state === 'PLAYING') this.toggleLights(this.playerForPad(i));
      if (this.state === 'TALLY' && pad.firePressed) {
        this.advanceTally();
        pad.firePressed = false;
      } else if (this.isGuest() && i === 0 && pad.firePressed && this.state === 'PLAYING') {
        this.net.taps++;
      }
    });
  }

  handlePlayerInput(p, idx, dt) {
    const input = this.readInput(idx);
    if (p.frozenTimer > 0) {
      p.moving = false;
      this.fireBuffer[idx] = 0;
      return;
    }

    const dir = input.dir;
    if (dir) {
      p.setDirection(dir, this.map);
      p.moveInDirection(dir, this.map);
    } else {
      p.moving = false;
    }

    // Shooting (single press or hold to auto-fire). A press while the previous shell
    // is still flying is kept for FIRE_BUFFER and fires as soon as that shell is gone
    if (input.tap || (input.fire && !this.fireHeld[idx])) this.fireBuffer[idx] = FIRE_BUFFER;
    if (this.fireBuffer[idx] > 0) {
      this.fireBuffer[idx] -= dt;
      if (this.tryShoot(p)) {
        this.fireBuffer[idx] = 0;
        this.fireAutoTimer[idx] = 0.16;
      }
    } else if (input.fire) {
      this.fireAutoTimer[idx] -= dt;
      if (this.fireAutoTimer[idx] <= 0 && this.tryShoot(p)) {
        this.fireAutoTimer[idx] = 0.16;
      }
    } else {
      this.fireAutoTimer[idx] = 0;
    }
    this.fireHeld[idx] = input.fire;
  }

  // If a tank overlaps something solid at its own position it could never move again:
  // move it to the nearest free spot (preferring the 16px rails tanks normally drive on)
  unstickTank(t) {
    if (!this.map.isBlocked(t.x, t.y, t.w, t.h, t.hasBoat, t, true)) {
      t.stuckFrames = 0;
      return;
    }
    t.stuckFrames = (t.stuckFrames || 0) + 1;
    if (t.stuckFrames < 3) return; // A one-frame touch is normal; only fix real overlaps
    if (!Game.unstickOffsets) {
      const list = [];
      for (let dy = -16; dy <= 16; dy++) {
        for (let dx = -16; dx <= 16; dx++) list.push([dx, dy, Math.hypot(dx, dy)]);
      }
      Game.unstickOffsets = list.sort((a, b) => a[2] - b[2]);
    }
    const railX = Math.round((t.x - 3) / 16) * 16 + 3;
    const railY = Math.round((t.y - 3) / 16) * 16 + 3;
    const tries = [[railX, railY]].concat(Game.unstickOffsets.map(([dx, dy]) => [t.x + dx, t.y + dy]));
    for (const [x, y] of tries) {
      if (!this.map.isBlocked(x, y, t.w, t.h, t.hasBoat, t, true) && (t.isBoss || !this.map.isEnclosed(x, y))) {
        t.x = x;
        t.y = y;
        t.stuckFrames = 0;
        t.slipping = false;
        return;
      }
    }
  }

  tryShoot(player) {
    if (!player || player.dead || player.frozenTimer > 0 || this.state !== 'PLAYING' || this.isGuest()) return false;
    const b = player.shoot();
    if (b) player.revealTimer = 1.5; // Muzzle flash gives the tank away at night
    this.addBullet(b);
    return !!b;
  }

  addBullet(b) {
    if (Array.isArray(b)) {
      b.forEach(x => this.addBullet(x));
      return;
    }
    if (!b) return;
    this.bullets.push(b);
    this.spawnMuzzleSparks(b.x + 3, b.y + 3, b.direction);
  }

  handleEnemySpawning(dt) {
    if (this.enemyReserve.length === 0) return;
    if (this.enemies.length + this.spawnAnimations.length >= this.maxOnScreenEnemies) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      // Pick spawn bay (0: Left, 1: Center, 2: Right)
      const bays = this.layout.enemySpawns;
      const bay = bays[this.spawnIndex % bays.length];
      this.spawnIndex++;

      const spawnX = bay.x * 16 + 3;
      const spawnY = bay.y * 16 + 3;

      // Check if spawn point is currently obstructed by a tank
      const isBlocked = this.enemies.some(e => Math.hypot(e.x - spawnX, e.y - spawnY) < 30) ||
                        this.players.some(p => !p.dead && Math.hypot(p.x - spawnX, p.y - spawnY) < 30);

      if (!isBlocked) {
        const tankConfig = this.enemyReserve.shift();
        this.enemiesSpawned++;

        if (tankConfig.isFlashing) sound.playBonusAlert();

        // Spawn warning star animation (1.0 second flashing)
        this.spawnAnimations.push({
          x: spawnX,
          y: spawnY,
          config: tankConfig,
          timer: 1.0,
          phase: 0
        });

        this.renderReserveIcons();
        this.spawnTimer = 2.0; // Wait before next spawn
      } else {
        this.spawnTimer = 0.5; // Try again soon
      }
    }
  }

  updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.update(dt, this.map);

      // Conquest: the map runs far above and below the screen; a shell that leaves the view
      // is gone (otherwise it flies on unseen for seconds and its owner cannot fire)
      if (!b.dead && this.layout.conquest && (b.y + b.h < this.camY || b.y > this.camY + this.viewH())) {
        b.dead = true;
        if (b.owner === 'player') sound.playRicochet('steel');
      }

      if (b.dead) {
        this.removeBullet(i);
        continue;
      }

      // 1. Bullet vs Bullet collision (Authentic Battle City: head-on shells cancel each other!)
      for (let j = i - 1; j >= 0; j--) {
        const b2 = this.bullets[j];
        if (b.owner !== b2.owner) {
          let collided = false;

          // AABB overlap with expanded collision radius
          if (b.x < b2.x + 9 && b.x + 9 > b2.x && b.y < b2.y + 9 && b.y + 9 > b2.y) {
            collided = true;
          } else {
            // Swept head-on corridor interception: prevents fast shells from skipping past each other!
            const isOpposite = (DIRS[b.direction].opp === b2.direction);
            if (isOpposite) {
              if (b.direction === 'UP' || b.direction === 'DOWN') {
                const laneAlign = Math.abs((b.x + 3) - (b2.x + 3)) <= 9;
                const distY = Math.abs((b.y + 3) - (b2.y + 3));
                const maxStep = b.speed + b2.speed + 6;
                if (laneAlign && distY <= maxStep) {
                  collided = true;
                }
              } else {
                const laneAlign = Math.abs((b.y + 3) - (b2.y + 3)) <= 9;
                const distX = Math.abs((b.x + 3) - (b2.x + 3));
                const maxStep = b.speed + b2.speed + 6;
                if (laneAlign && distX <= maxStep) {
                  collided = true;
                }
              }
            }
          }

          if (collided) {
            b.dead = true;
            b2.dead = true;
            const midX = (b.x + b2.x) / 2 + 3;
            const midY = (b.y + b2.y) / 2 + 3;
            this.explosions.push(new ExplosionEffect(midX, midY, false));
            this.spawnRicochetSparks(midX, midY);
            sound.playRicochet('bullet');
            break;
          }
        }
      }
      if (b.dead) {
        this.removeBullet(i);
        continue;
      }

      // 2. Player shell sets off a mine
      if (b.owner === 'player' && this.mines.length) {
        const mi = this.mines.findIndex(m => Math.abs(b.x + 3 - m.x) < 6 && Math.abs(b.y + 3 - m.y) < 6);
        if (mi !== -1) {
          this.explodeMine(this.mines[mi]);
          this.mines.splice(mi, 1);
          this.addScore(50, b.x, b.y, b.shooter);
          b.dead = true;
          this.removeBullet(i);
          continue;
        }
      }

      // 2a. Bullet vs fortress turrets (conquest)
      const hitTurret = b.owner === 'player' && this.turrets.find(t => t.alive && b.collidesWith(t));
      if (hitTurret) {
        b.dead = true;
        this.hitTurret(hitTurret, b);
        this.removeBullet(i);
        continue;
      }

      // 2b'. Player shell breaks a city searchlight
      const lampCity = b.owner === 'player' && this.cities.find(c => c.alive && !c.lampDead &&
        Math.abs(b.x + 3 - (c.x + 28)) < 5 && Math.abs(b.y + 3 - (c.y + 1)) < 5);
      if (lampCity) {
        lampCity.lampDead = true;
        this.spawnRicochetSparks(b.x + 3, b.y + 3);
        sound.playRicochet('bullet');
        this.addScore(100, b.x, b.y, b.shooter);
        b.dead = true;
        this.removeBullet(i);
        continue;
      }

      // 2b. Bullet vs enemy headquarters (conquest)
      const hitHQ = this.cities.find(city => city.alive && b.collidesWith(city));
      if (hitHQ) {
        b.dead = true;
        this.hitCity(hitHQ, b);
        this.removeBullet(i);
        continue;
      }

      // 2. Bullet vs Base Eagle(s)
      const hitBase = this.bases.find(base => base.alive && b.collidesWith(base));
      if (hitBase) {
        b.dead = true;
        hitBase.hit();
        const bx = hitBase.x + 16;
        const by = hitBase.y + 16;
        this.explosions.push(new ExplosionEffect(bx, by, true));
        this.addScreenShake(6);
        if (!hitBase.alive) {
          this.addScreenShake(8);
          this.spawnTankDebris(bx, by, ['#ffd54f', '#bdbdbd', '#8d6e63', '#ff7043']);
          this.spawnRing(bx, by, '#ff5722', 46, 0.7);
          this.flashScreen();
        } else {
          this.spawnRing(bx, by, '#ff1744', 26, 0.4);
        }
        this.removeBullet(i);
        continue;
      }

      // 3. Bullet vs Map Tiles (Brick / Steel / Trees)
      if (this.map.hitTileWithBullet(b)) {
        b.dead = true;
        this.explosions.push(new ExplosionEffect(b.x + 3, b.y + 3, false));
        this.removeBullet(i);
        continue;
      }

      // 4. Bullet vs Tanks
      if (b.owner === 'player') {
        // Player bullet hits enemy
        for (let eIdx = this.enemies.length - 1; eIdx >= 0; eIdx--) {
          const enemy = this.enemies[eIdx];
          if (b.collidesWith(enemy)) {
            b.dead = true;
            const killed = enemy.takeDamage();
            if (killed) {
              this.destroyEnemy(enemy, eIdx, b.shooter);
            } else {
              this.explosions.push(new ExplosionEffect(b.x + 3, b.y + 3, false));
              this.spawnRicochetSparks(b.x + 3, b.y + 3);
              this.spawnRing(b.x + 3, b.y + 3, '#ffffff', 12, 0.25);
            }
            break;
          }
        }

        // Player bullet hits the other player: paralysis, no damage
        if (!b.dead) {
          for (const p of this.players) {
            if (p === b.shooter || p.dead || !b.collidesWith(p)) continue;
            b.dead = true;
            sound.playRicochet(p.shieldTimer > 0 ? 'shield' : 'armor');
            this.spawnRicochetSparks(b.x + 3, b.y + 3);
            if (p.shieldTimer <= 0) {
              p.frozenTimer = Math.max(p.frozenTimer, FRIENDLY_FIRE_FREEZE);
              p.moving = false;
              this.spawnRing(p.x + 13, p.y + 13, '#9be7ff', 20, 0.4);
            }
            break;
          }
        }
      } else if (b.owner === 'enemy') {
        // Enemy bullet hits player
        for (const p of this.players) {
          if (p.dead || !b.collidesWith(p)) continue;
          b.dead = true;
          if (p.shieldTimer <= 0) {
            this.killPlayer(p);
          } else {
            // Shield absorbed hit!
            sound.playRicochet('shield');
            this.explosions.push(new ExplosionEffect(b.x + 3, b.y + 3, false));
            this.spawnRicochetSparks(b.x + 3, b.y + 3);
            this.spawnRing(b.x + 3, b.y + 3, '#80deea', 14, 0.3);
          }
          break;
        }
      }

      if (b.dead) {
        this.removeBullet(i);
      }
    }
  }

  destroyEnemy(enemy, index, killer) {
    const cx = enemy.x + (enemy.w || 26) / 2 + 1;
    const cy = enemy.y + (enemy.h || 26) / 2 + 1;
    this.explosions.push(new ExplosionEffect(cx, cy, true));
    this.spawnTankDebris(cx, cy, ['#78909c', '#b0bec5', '#455a64', '#ff8a65']);
    this.spawnRing(cx, cy, '#ffcc80', 30, 0.45);
    this.addScreenShake(3.5);
    sound.playExplosion(true);
    if (killer) killer.kills[enemy.type] = (killer.kills[enemy.type] || 0) + 1;
    const nightBonus = this.nightBonusActive();
    this.addScore(nightBonus ? Math.round(enemy.points * 1.5) : enemy.points, cx, cy, killer);

    // Spawn power-up if bonus tank (at night sometimes from any tank)
    if (enemy.isFlashing || (nightBonus && Math.random() < 0.12)) {
      this.spawnRandomPowerUp(enemy.x, enemy.y);
    }

    if (enemy.isBoss) {
      this.flashScreen();
      this.addScreenShake(8);
      this.spawnRing(cx, cy, '#ff1744', 70, 0.9);
      this.spawnTankDebris(cx + 10, cy - 8, ['#7a1420', '#4a0a12', '#ff6b6b']);
      this.spawnRandomPowerUp(enemy.x, enemy.y);
      this.spawnRandomPowerUp(enemy.x + 26, enemy.y + 26);
      this.floatingScores.push(new FloatingScore(cx, cy - 20, 0, { text: 'BOSS DESTROYED', color: '#ffd54f', duration: 2.5, rise: 10 }));
      this.conquestStatsAdd('bosses');
    }
    this.enemies.splice(index, 1);
    this.renderReserveIcons();
  }

  killPlayer(p) {
    if (p.armor > 0) {
      // Conquest armour upgrade: a plate breaks instead of the tank
      p.armor--;
      this.spawnRicochetSparks(p.x + 13, p.y + 13);
      this.spawnRing(p.x + 13, p.y + 13, '#80deea', 22, 0.35);
      sound.playRicochet('armor');
      p.shieldTimer = Math.max(p.shieldTimer, 0.6); // A moment to get away
      return;
    }
    p.dead = true;
    p.lives--;
    p.respawnTimer = 1.5;
    const cx = p.x + 14;
    const cy = p.y + 14;
    const c = PLAYER_COLORS[p.index];
    this.explosions.push(new ExplosionEffect(cx, cy, true));
    this.spawnTankDebris(cx, cy, c);
    this.spawnRing(cx, cy, c[0], 34, 0.5);
    this.addScreenShake(7);
    sound.playExplosion(true);
    this.updateHUD();

    // Two-player game: show GAME OVER over a player who is out while the partner fights on
    if (p.lives <= 0 && this.players.some(o => o !== p && !(o.dead && o.lives <= 0))) {
      this.floatingScores.push(new FloatingScore(p.spawnX + 13, p.spawnY + 10, 0, {
        text: 'GAME OVER', color: '#ff5252', duration: 2.4, rise: 8
      }));
    }
  }

  removeBullet(index) {
    const b = this.bullets[index];
    if (b.shooter) {
      b.shooter.activeBullets = Math.max(0, b.shooter.activeBullets - 1);
    }
    this.bullets.splice(index, 1);
  }

  // -------------------------------------------------------------
  // POWER-UP MECHANICS (Tank 1990 Authentic)
  // -------------------------------------------------------------
  spawnRandomPowerUp(x, y) {
    sound.playPowerUpSpawn();
    const bonuses = ['star', 'helmet', 'clock', 'shovel', 'grenade', 'tank', 'gun', 'boat']
      .filter(b => !(this.layout.conquest && b === 'shovel')) // No Eagle of yours to fortify
      .concat(this.flareAllowed() ? ['flare'] : []);
    const chosen = bonuses[Math.floor(Math.random() * bonuses.length)];

    const spot = this.findPowerUpSpot() || {
      // Fallback: where the bonus tank died, snapped to the tile grid
      x: Math.min(this.map.pxW - 32, Math.max(16, Math.round(x / 16) * 16)),
      y: Math.min(this.map.pxH - 32, Math.max(16, Math.round(y / 16) * 16))
    };
    const px = spot.x;
    const py = spot.y;

    this.powerups.push(new PowerUpItem(px, py, chosen));
    this.spawnRing(px + 14, py + 14, '#fff59d', 24, 0.4);
  }

  // Random spot for a bonus (classic Battle City): on the 16px grid, on open ground,
  // bricks, trees or ice, but not on steel or water (a tank could never reach it there),
  // not on an Eagle or its bunker, and not right under a player tank
  findPowerUpSpot() {
    const T = MapGenerator.TILES;
    const maxC = this.map.cols - 2;
    // Conquest: only on the part of the world that is on screen
    const minR = Math.max(0, Math.floor(this.camY / 16) + 1);
    const maxR = Math.min(this.map.rows - 2, Math.floor((this.camY + this.viewH()) / 16) - 3);
    for (let attempt = 0; attempt < 80; attempt++) {
      const c = Math.floor(Math.random() * (maxC + 1));
      const r = minR + Math.floor(Math.random() * (maxR - minR + 1));
      let ok = true;
      for (let dr = 0; dr < 2 && ok; dr++) {
        for (let dc = 0; dc < 2 && ok; dc++) {
          const tile = this.map.grid[r + dr][c + dc];
          if (tile === T.STEEL || tile === T.WATER || this.map.fortOwner.has((r + dr) * this.map.cols + c + dc)) ok = false;
        }
      }
      if (!ok) continue;
      const x = c * 16;
      const y = r * 16;
      if (this.bases.some(b => this.map.rectsOverlap(x, y, 32, 32, b.x, b.y, b.w, b.h))) continue;
      if (this.players.some(p => !p.dead && Math.hypot(p.x - x, p.y - y) < 48)) continue;
      return { x, y };
    }
    return null;
  }

  applyPlayerPowerup(player, type) {
    sound.playPowerUpCollect(type);
    const cx = player.x + 14;
    const cy = player.y + 14;
    this.addScore(500, cx, cy, player);
    this.spawnRing(cx, cy, '#fff59d', 30, 0.5);
    this.spawnSparkles(cx, cy, ['#ffffff', '#fff59d', '#ffd54f'], 14);

    switch (type) {
      case 'star':
        // If player already reached Tier 4 (3 stars), award 1000 bonus score!
        if (player.tier >= 4) {
          this.addScore(1000, cx, cy, player);
        } else {
          player.upgradeTier();
        }
        break;
      case 'gun': // Tank 1990: Instant Max 3 Stars (Tier 4 Destroyer) + 10s Shield!
        player.upgradeTier(4);
        player.shieldTimer = 10.0;
        break;
      case 'helmet':
        player.shieldTimer = 10.0;
        break;
      case 'clock':
        this.isFrozen = true;
        this.freezeTimer = 10.0;
        this.enemies.forEach(e => this.spawnRing(e.x + 13, e.y + 13, '#9be7ff', 22, 0.5));
        break;
      case 'shovel': {
        // Fortifies the Eagle nearest to the player who picked it up
        const base = this.nearestBase(player);
        if (!base) break;
        this.map.setBaseWalls(MapGenerator.TILES.STEEL, base.walls);
        base.fortify(20.0);
        base.walls.forEach(pt => {
          this.spawnSparkles(pt.x * 16 + 8, pt.y * 16 + 8, ['#ffffff', '#b3e5fc', '#90a4ae'], 3);
        });
        break;
      }
      case 'tank':
        player.lives++;
        break;
      case 'flare':
        // Signal flare: a bright light over this spot for ten seconds
        this.flares.push({ x: cx, y: cy, t: 0, dur: 10 });
        this.spawnRing(cx, cy, '#fff59d', 50, 0.7);
        break;
      case 'boat':
        player.hasBoat = true;
        break;
      case 'grenade':
        // Destroy all enemies on screen!
        for (let i = this.enemies.length - 1; i >= 0; i--) {
          const e = this.enemies[i];
          this.explosions.push(new ExplosionEffect(e.x + 14, e.y + 14, true));
          this.spawnTankDebris(e.x + 14, e.y + 14, ['#78909c', '#b0bec5', '#455a64', '#ff8a65']);
          player.kills[e.type] = (player.kills[e.type] || 0) + 1;
          this.addScore(e.points, e.x + 14, e.y + 14, player);
        }
        this.enemies = [];
        sound.playExplosion(true);
        this.addScreenShake(6);
        this.flashScreen();
        this.renderReserveIcons();
        break;
    }

    this.updateHUD();
  }

  applyEnemyPowerup(enemy, type) {
    // Tank 1990 Authentic Bonus Rules: Enemies can pick up power-ups!
    sound.playPowerUpCollect('enemy');
    this.spawnRing(enemy.x + 13, enemy.y + 13, '#ff5252', 28, 0.5);
    if (type === 'boat') {
      enemy.hasBoat = true;
    } else if (type === 'helmet') {
      enemy.hp += 2; // Extra shield armor
    } else if (type === 'star' || type === 'gun') {
      enemy.speed = Math.min(2.5, enemy.speed * 1.35);
      enemy.bulletSpeed = Math.min(5.5, enemy.bulletSpeed * 1.35);
      enemy.maxBullets = 2;
    } else if (type === 'clock') {
      // Tank 1990: Enemy freezes players!
      this.players.forEach(p => {
        if (!p.dead) p.frozenTimer = Math.max(p.frozenTimer, 4.0);
      });
      sound.playBonusAlert();
    } else if (type === 'shovel') {
      // Tank 1990: Enemy removes the walls of the nearest base!
      const base = this.nearestBase(enemy);
      if (!base) return;
      this.map.setBaseWalls(MapGenerator.TILES.EMPTY, base.walls);
      base.walls.forEach(pt => this.spawnBrickDebris(pt.x * 16 + 8, pt.y * 16 + 8));
      sound.playExplosion(false);
    } else if (type === 'tank') {
      // Enemy adds a reinforcement tank!
      this.enemyReserve.unshift({ type: 'armor', hp: 4, points: 400, isFlashing: false });
      this.renderReserveIcons();
    } else if (type === 'grenade') {
      // Enemy destroys player tanks!
      this.players.forEach(p => {
        if (!p.dead && p.shieldTimer <= 0) this.killPlayer(p);
      });
    }
  }

  // -------------------------------------------------------------
  // STAGE VICTORY & GAME OVER
  // -------------------------------------------------------------
  clearTallyTimers() {
    this.tallyTimers.forEach(t => clearTimeout(t));
    this.tallyTimers = [];
  }

  triggerStageComplete() {
    if (this.demo) {
      this.restartDemo();
      return;
    }
    this.state = 'TALLY';
    this.tallyReady = false;
    sound.stopEngineHum();
    this.clearTallyTimers();

    const types = ['basic', 'fast', 'power', 'armor'];
    const p1 = this.players[0];
    const p2 = this.players[1] || null;
    const tallyScreen = document.getElementById('tally-screen');
    const prompt = tallyScreen.querySelector('.tally-next-prompt');
    document.getElementById('tally-stage-num').textContent = this.stage;
    prompt.classList.remove('ready');
    if (this.layoutName === 'big') {
      this.runBigTally(tallyScreen, prompt, types);
      return;
    }
    const names = this.online ? this.playerNames : null;
    document.getElementById('tally-p1-label').textContent = (names && names[0]) || 'I-PLAYER';
    document.getElementById('tally-p2-label').textContent = (names && names[1]) || 'II-PLAYER';
    document.getElementById('tally-player-score').textContent = p1.score;
    document.getElementById('tally-player2-score').textContent = p2 ? p2.score : 0;
    prompt.classList.remove('ready');

    // Render tally icons
    types.forEach((t, i) => {
      const c = document.getElementById('tally-icon-' + i);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 32, 32);
      Sprites.drawTank(ctx, 2, 2, { type: t, direction: 'UP', trackAnim: 0 });
    });

    const setRow = (i, k) => {
      const pts = (i + 1) * 100;
      const k1 = Math.min(k, p1.kills[types[i]]);
      this.setTallyText('tally-count-' + i, k1);
      document.getElementById('tally-pts-' + i).textContent = (k1 * pts) + ' PTS';
      if (p2) {
        const k2 = Math.min(k, p2.kills[types[i]]);
        this.setTallyText('tally2-count-' + i, k2);
        document.getElementById('tally2-pts-' + i).textContent = (k2 * pts) + ' PTS';
      }
    };
    const total = (p) => types.reduce((sum, t) => sum + p.kills[t], 0);
    const finish = () => {
      types.forEach((t, i) => {
        document.getElementById('tally-row-' + i).classList.add('shown');
        setRow(i, Infinity);
      });
      document.getElementById('tally-total-kills').textContent = total(p1);
      document.getElementById('tally2-total-kills').textContent = p2 ? total(p2) : 0;
      prompt.classList.add('ready');
      this.tallyReady = true;
    };
    this.finishTally = finish;

    // Reset rows, then count kills up one by one (classic NES tally)
    types.forEach((t, i) => {
      document.getElementById('tally-row-' + i).classList.remove('shown');
      setRow(i, 0);
    });
    document.getElementById('tally-total-kills').textContent = '';
    document.getElementById('tally2-total-kills').textContent = '';

    let at = 350;
    const schedule = (fn) => this.tallyTimers.push(setTimeout(fn, at));
    types.forEach((t, i) => {
      schedule(() => document.getElementById('tally-row-' + i).classList.add('shown'));
      at += 220;
      const maxKills = Math.max(p1.kills[t], p2 ? p2.kills[t] : 0);
      for (let k = 1; k <= maxKills; k++) {
        schedule(() => {
          setRow(i, k);
          sound.playTallyBeep();
        });
        at += 110;
      }
      at += 200;
    });
    schedule(finish);

    tallyScreen.classList.remove('hidden');
    this.netUi('tally');
  }

  // Big map tally: a column per player, kills count up row by row
  runBigTally(tallyScreen, prompt, types) {
    const players = this.players;
    const names = this.online ? this.playerNames : null;
    const grid = document.getElementById('tally-big');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `64px repeat(${players.length}, 96px)`;
    const cell = (text, cls = '', color = null) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      if (color) d.style.setProperty('--slot-color', color);
      grid.appendChild(d);
      return d;
    };

    cell('');
    players.forEach((p, i) => cell((names && names[i]) || this.defaultName(i), 'tb-name', PLAYER_COLORS[i][0]));
    const counts = types.map(t => {
      const icon = document.createElement('canvas');
      icon.width = 32;
      icon.height = 32;
      icon.className = 'tally-icon';
      Sprites.drawTank(icon.getContext('2d'), 2, 2, { type: t, direction: 'UP', trackAnim: 0 });
      grid.appendChild(icon);
      return players.map(() => cell('0', 'tally-count'));
    });
    cell('TOTAL', 'tb-total');
    const totals = players.map(() => cell('', 'tally-count'));
    cell('PTS', 'tb-total');
    players.forEach(p => cell(String(p.score), 'tb-score'));

    const bump = (el, value) => {
      const text = String(value);
      if (el.textContent === text) return;
      el.textContent = text;
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    };
    const finish = () => {
      types.forEach((t, r) => players.forEach((p, i) => { counts[r][i].textContent = p.kills[t]; }));
      players.forEach((p, i) => { totals[i].textContent = types.reduce((sum, t) => sum + p.kills[t], 0); });
      prompt.classList.add('ready');
      this.tallyReady = true;
    };
    this.finishTally = finish;

    let at = 350;
    const schedule = (fn) => this.tallyTimers.push(setTimeout(fn, at));
    types.forEach((t, r) => {
      const maxKills = Math.max(...players.map(p => p.kills[t]));
      for (let k = 1; k <= maxKills; k++) {
        schedule(() => {
          players.forEach((p, i) => bump(counts[r][i], Math.min(k, p.kills[t])));
          sound.playTallyBeep();
        });
        at += 90;
      }
      at += 200;
    });
    schedule(finish);

    tallyScreen.classList.remove('hidden');
    this.netUi('tally');
  }

  setTallyText(id, value) {
    const el = document.getElementById(id);
    const text = String(value);
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  advanceTally() {
    if (this.state !== 'TALLY') return;
    if (!this.tallyReady) {
      // First press skips the counting animation
      this.clearTallyTimers();
      if (this.finishTally) this.finishTally();
      return;
    }
    if (this.isGuest()) this.net.send({ t: 'cmd', c: 'next' });
    else this.nextStage();
  }

  triggerGameOver() {
    if (this.demo) {
      this.restartDemo();
      return;
    }
    this.state = 'GAMEOVER';
    this.recordScores();
    sound.stopEngineHum();
    sound.playGameOver();
    this.gameOverText = { y: 450, target: 200 };
    this.netUi('gameover');

    setTimeout(() => {
      if (this.state !== 'GAMEOVER') return;
      this.setLogo('GAME', 'OVER');
      if (this.layout.conquest) this.renderConquestStats();
      if (this.online) this.showMenu('onlineOver');
      else if (this.layout.conquest) this.showMenu('conquestOver');
      else this.showMenu('main', this.localBig ? 2 : (this.twoPlayers ? 1 : 0));
      document.getElementById('game-overlay').classList.remove('hidden');
      this.gameOverText = null;
    }, 2600);
  }

  // -------------------------------------------------------------
  // ONLINE PLAY (host simulates, guests mirror; see net.js)
  // Classic room: host + 1 guest, starts on join.
  // Big room: host + up to 3 guests on the wide map, host presses START.
  // -------------------------------------------------------------
  netUi(name, data = {}) {
    if (this.online && this.net && this.net.isHost) this.net.ui.push(Object.assign({ u: name }, data));
  }

  netErrorText(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') return 'CODE NOT FOUND';
    if (type === 'timeout') return 'NO RESPONSE';
    if (type === 'full') return 'ROOM IS FULL';
    if (type === 'browser-incompatible') return 'BROWSER NOT SUPPORTED';
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) return 'SERVER UNAVAILABLE';
    return 'CONNECTION ERROR';
  }

  // -------------------------------------------------------------
  // ONLINE CHAT (messages go through the host, like everything else)
  // -------------------------------------------------------------
  chatAvailable() {
    return !!(this.net && this.net.connected);
  }

  // A key the player bound to an action in SETTINGS keeps its action
  isBoundCode(code) {
    return [0, 1].some(idx => {
      const b = this.getBindings(idx);
      return b && Object.values(b).some(list => Array.isArray(list) && list.includes(code));
    });
  }

  openChat() {
    if (this.chatOpen || !this.chatAvailable()) return;
    this.chatOpen = true;
    // Let go of everything held, or the tank keeps driving while you type
    this.keys = {};
    this.dirHistory = this.dirHistory.map(() => []);
    this.isMouseDown = false;
    const input = document.getElementById('chat-input');
    input.value = '';
    input.classList.remove('hidden');
    document.getElementById('chat-log').classList.add('open');
    input.focus();
  }

  closeChat(send) {
    if (!this.chatOpen) return;
    this.chatOpen = false;
    const input = document.getElementById('chat-input');
    const text = input.value;
    input.value = '';
    input.classList.add('hidden');
    input.blur();
    document.getElementById('chat-log').classList.remove('open');
    if (send) this.sendChat(text);
  }

  sendChat(text) {
    text = cleanChatText(text);
    if (!text || !this.chatAvailable()) return;
    if (this.net.isHost) this.postChat(0, this.playerName, text);
    else this.net.send({ t: 'chat', text });
  }

  // Host: show a message and pass it on to every guest
  postChat(slot, name, text) {
    text = cleanChatText(text);
    if (!text) return;
    this.showChat(slot, name, text);
    this.net.send({ t: 'chat', slot, name, text });
  }

  showChat(slot, name, text) {
    if (!text) return;
    const log = document.getElementById('chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.style.setProperty('--chat-life', CHAT_LINE_TIME + 'ms');
    const who = document.createElement('span');
    who.className = 'chat-name';
    who.style.color = PLAYER_COLORS[Math.max(0, Math.min(MAX_PLAYERS - 1, slot))][0];
    who.textContent = (name || this.defaultName(slot)) + ':';
    line.append(who, ' ' + text);
    log.appendChild(line);
    while (log.children.length > CHAT_LINES) log.firstChild.remove();
    setTimeout(() => line.remove(), CHAT_LINE_TIME);
    // Played directly: the net wrapper around sounds would replay it on the guests
    SoundEngine.prototype.playRicochet.call(sound, 'shield');
  }

  closeNet() {
    this.closeChat(false);
    document.getElementById('chat-log').innerHTML = '';
    if (this.net) this.net.close();
    this.net = null;
    this.online = false;
  }

  defaultName(index) {
    return 'PLAYER ' + (index + 1);
  }

  hostOnline(big = false, conquest = false) {
    if (typeof Peer === 'undefined') {
      this.setNetStatus('SERVER UNAVAILABLE');
      return;
    }
    this.stopDemo();
    this.closeNet();
    const net = new NetSession(this, true, big ? MAX_PLAYERS - 1 : 1);
    net.big = big;
    net.conquest = conquest;
    this.net = net;
    this.playerNames = [this.playerName];
    this.remoteInputs = [];
    this.remoteTapsSeen = [];
    document.getElementById('net-code').textContent = '';
    this.showMenu(big ? 'lobby' : 'hosting', big ? 1 : 0); // Cursor on COPY LINK
    this.renderLobby();
    this.setNetStatus('CREATING ROOM', true);
    net.host(code => {
      if (this.net !== net) return;
      document.getElementById('net-code').textContent = code;
      this.setNetStatus('WAITING FOR PLAYERS', true);
    }, peer => {
      if (this.net !== net) return;
      this.onGuestJoined(peer);
    }, err => {
      if (this.net !== net) return;
      this.closeNet();
      this.showMenu('online');
      this.setNetStatus(this.netErrorText(err));
    });
  }

  onGuestJoined(peer) {
    const net = this.net;
    // First free player slot (the host is always slot 0)
    const used = net.peers.filter(p => p !== peer).map(p => p.slot);
    let slot = 1;
    while (used.includes(slot)) slot++;
    peer.slot = slot;
    peer.name = this.defaultName(slot);
    this.online = true;
    this.playerNames[slot] = peer.name;
    net.sendTo(peer, { t: 'welcome', slot, big: net.big });

    if (!net.big) {
      // Classic room: the game starts as soon as the partner is here
      net.locked = true;
      this.remoteInputs = [];
      this.remoteTapsSeen = [];
      this.startNewGame(true, net.conquest ? 'conquest' : 'classic');
      return;
    }
    this.renderLobby();
  }

  // Remove gaps in the slots (someone left the lobby) and start the wide-map game
  startBigOnline() {
    const net = this.net;
    if (!net || !net.isHost || !net.big) return;
    if (net.peers.length === 0) {
      this.setNetStatus('NEED ONE MORE PLAYER');
      return;
    }
    net.locked = true;
    this.playerNames = [this.playerName];
    net.peers.sort((a, b) => a.slot - b.slot).forEach((peer, i) => {
      peer.slot = i + 1;
      this.playerNames[peer.slot] = peer.name;
      net.sendTo(peer, { t: 'welcome', slot: peer.slot, big: true });
    });
    this.remoteInputs = [];
    this.remoteTapsSeen = [];
    this.setLogo('TANK', '2026');
    this.startNewGame(true, net.conquest ? 'conquest' : 'big', 1 + net.peers.length);
  }

  // Names of everyone in the room (host's lobby screen, and sent to guests)
  lobbyNames() {
    if (!this.net) return [];
    const names = [this.playerName];
    this.net.peers.slice().sort((a, b) => a.slot - b.slot).forEach(p => names.push(p.name));
    return names;
  }

  renderLobby(names = null) {
    const list = names || this.lobbyNames();
    const el = document.getElementById('net-lobby');
    el.innerHTML = '';
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const row = document.createElement('div');
      row.className = 'lobby-slot' + (list[i] ? ' taken' : '');
      row.style.setProperty('--slot-color', PLAYER_COLORS[i][0]);
      row.textContent = list[i] || '---';
      el.appendChild(row);
    }
    if (this.net && this.net.isHost && this.net.big) {
      this.net.send({ t: 'lobby', names: list });
    }
  }

  // Clipboard, with the old execCommand fallback for plain-http pages (LAN address)
  copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      // Copy refused: the caller shows the code instead
    }
    area.remove();
    return ok;
  }

  // Host: link that opens the game straight into this room (?join=CODE)
  copyRoomLink() {
    const code = document.getElementById('net-code').textContent;
    if (!code) return; // Room not created yet
    const link = location.origin + location.pathname + '?join=' + code;
    if (!this.copyText(link)) {
      this.setNetStatus('COPY FAILED, SEND THE CODE');
      return;
    }
    // A localhost link only opens on this computer
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
    this.setNetStatus(local ? 'LINK COPIED (THIS PC ONLY)' : 'LINK COPIED', true);
  }

  // Guest: ?join=CODE in the address connects to that room right away
  joinFromLink() {
    const params = new URLSearchParams(location.search);
    const code = (params.get('join') || '').trim().toUpperCase();
    if (!code) return;
    // Drop it from the address so a reload later does not rejoin an old room
    params.delete('join');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
    if (!/^[A-Z0-9]{4,6}$/.test(code)) return;
    this.showMenu('join');
    document.getElementById('net-join-code').value = code;
    this.joinOnline();
  }

  joinOnline() {
    if (this.menuName !== 'join') return;
    const code = document.getElementById('net-join-code').value.trim().toUpperCase();
    if (code.length < 4) {
      this.setNetStatus('ENTER THE CODE');
      return;
    }
    if (typeof Peer === 'undefined') {
      this.setNetStatus('SERVER UNAVAILABLE');
      return;
    }
    this.stopDemo();
    this.closeNet();
    const net = new NetSession(this, false);
    this.net = net;
    this.guestBig = false;
    this.setNetStatus('CONNECTING', true);
    net.join(code, () => {
      if (this.net !== net) return;
      this.online = true;
      this.localIndex = 1; // Until the host's welcome says otherwise
      this.playerNames = [this.defaultName(0), this.playerName];
      net.send({ t: 'hello', name: this.playerName });
      this.showMenu('waiting');
      this.renderLobby([]);
      this.setNetStatus('WAITING FOR HOST', true);
    }, err => {
      if (this.net !== net) return;
      this.closeNet();
      this.setNetStatus(this.netErrorText(err));
    });
  }

  requestRestartOnline() {
    if (this.isGuest()) {
      this.net.send({ t: 'cmd', c: 'again' });
      this.setNetStatus('WAITING FOR HOST', true);
    } else {
      this.restartOnline();
    }
  }

  restartOnline() {
    if (this.net && this.net.big) this.startBigOnline();
    else this.startNewGame(true, this.net && this.net.conquest ? 'conquest' : 'classic');
  }

  exitOnline() {
    this.leaveOnline('');
  }

  // Guest: the host is gone
  onNetLost() {
    const host = this.playerNames && this.playerNames[0];
    const partner = this.net && this.net.isHost ? (this.playerNames && this.playerNames[1]) : host;
    this.leaveOnline(partner ? partner + ' DISCONNECTED' : 'CONNECTION LOST');
  }

  // Host: one guest left
  onGuestLeft(peer) {
    const name = peer.name || this.defaultName(peer.slot || 1);
    if (!this.net.big) {
      this.leaveOnline(name + ' DISCONNECTED');
      return;
    }
    if (!this.net.locked) {
      // Still in the lobby
      if (this.playerNames) this.playerNames[peer.slot] = undefined;
      this.online = this.net.peers.length > 0;
      this.renderLobby();
      this.setNetStatus(name + ' LEFT');
      return;
    }
    // Mid-game: that tank is out, the others play on
    const p = this.players[peer.slot];
    this.remoteInputs[peer.slot] = null;
    if (p) {
      if (!p.dead) {
        this.explosions.push(new ExplosionEffect(p.x + 14, p.y + 14, true));
        p.dead = true;
      }
      p.lives = 0;
      this.floatingScores.push(new FloatingScore(p.spawnX + 13, p.spawnY + 10, 0, {
        text: name + ' LEFT', color: '#ff5252', duration: 3, rise: 8
      }));
    }
    this.updateHUD();
  }

  // Back to the title screen when the online session ends
  leaveOnline(message) {
    this.closeNet();
    this.playerNames = null;
    this.localIndex = 0;
    this.remoteInputs = [];
    this.remoteTapsSeen = [];
    this.stageToken++;
    this.clearTallyTimers();
    sound.stopEngineHum();
    this.state = 'TITLE';
    this.twoPlayers = false;
    this.playerCount = 1;
    this.localBig = false;
    this.camY = 0;
    this.cities = [];
    this.turrets = [];
    this.setLayout('classic');
    document.getElementById('arcade-cabinet').classList.remove('two-players');
    document.getElementById('stage-screen').classList.add('hidden');
    document.getElementById('tally-screen').classList.add('hidden');
    this.gameOverText = null;
    this.bullets = [];
    this.enemies = [];
    this.powerups = [];
    this.explosions = [];
    this.floatingScores = [];
    this.spawnAnimations = [];
    this.rings = [];
    this.treadMarks = [];
    this.decals = [];
    this.parts = [];
    this.lights = [];
    this.treeRustle.clear();
    this.stage = 1;
    this.enemyReserve = this.map.loadLevel(1);
    this.createBases();
    this.createPlayers();
    this.netReserve = undefined;
    this.renderReserveIcons(false);
    this.updateHUD();
    this.setLogo('TANK', '2026');
    this.showMenu('main', 4);
    this.setNetStatus(message);
    document.getElementById('game-overlay').classList.remove('hidden');
    this.startDemo();
  }

  onNetMessage(msg, peer) {
    if (!this.net || !msg) return;
    if (this.net.isHost) {
      if (!peer || !peer.slot) return;
      if (msg.t === 'in') {
        this.remoteInputs[peer.slot] = {
          dir: DIR_ACTIONS.includes(msg.dir) ? msg.dir : null,
          fire: !!msg.fire,
          taps: msg.taps | 0
        };
      } else if (msg.t === 'hello') {
        peer.name = cleanPlayerName(msg.name) || this.defaultName(peer.slot);
        if (this.playerNames) this.playerNames[peer.slot] = peer.name;
        if (this.net.big && !this.net.locked) this.renderLobby();
        this.updateHUD();
      } else if (msg.t === 'chat') {
        // Relay to everyone (the sender included); at most one message per 0.4 s
        const now = performance.now();
        if (now - (peer.lastChat || 0) < 400) return;
        peer.lastChat = now;
        this.postChat(peer.slot, peer.name, msg.text);
      } else if (msg.t === 'cmd') {
        if (msg.c === 'pause') this.togglePause();
        else if (msg.c === 'pick' && this.state === 'UPGRADE') this.pickUpgrade(msg.i | 0);
        else if (msg.c === 'next' && this.state === 'TALLY') this.nextStage();
        else if (msg.c === 'again' && this.state === 'GAMEOVER') this.restartOnline();
      }
      return;
    }

    if (msg.t === 'welcome') {
      this.localIndex = Math.max(1, Math.min(MAX_PLAYERS - 1, msg.slot | 0));
      this.guestBig = !!msg.big;
      document.getElementById('net-lobby').classList.toggle('hidden', !(this.menuName === 'waiting' && this.guestBig));
    } else if (msg.t === 'full') {
      this.closeNet();
      this.showMenu('join');
      this.setNetStatus(this.netErrorText({ type: 'full' }));
    } else if (msg.t === 'lobby') {
      if (Array.isArray(msg.names)) this.renderLobby(msg.names.map(n => cleanPlayerName(n)).slice(0, MAX_PLAYERS));
    } else if (msg.t === 'chat') {
      this.showChat(msg.slot | 0, cleanPlayerName(msg.name), cleanChatText(msg.text));
    } else if (msg.t === 'snap') {
      if (msg.s) this.applySnapshot(msg.s);
      (msg.ui || []).forEach(u => this.applyNetUi(u));
      (msg.ev || []).forEach(ev => {
        if (ev.s && NET_SOUNDS.includes(ev.s)) sound[ev.s](...(ev.a || []));
        else if (ev.f && NET_FX.includes(ev.f)) this[ev.f](...(ev.a || []));
      });
    }
  }

  encodeMap() {
    let s = '';
    for (let r = 0; r < this.map.rows; r++) {
      for (let c = 0; c < this.map.cols; c++) {
        s += this.map.grid[r][c].toString(36) + this.map.brickMasks[r][c].toString(16);
      }
    }
    return s;
  }

  decodeMap(str) {
    // Resize the local grid when the host switched between classic and big maps
    const rows = this.layout.rows;
    const cols = this.layout.cols;
    if (str.length !== rows * cols * 2) return;
    if (!this.map.grid || this.map.rows !== rows || this.map.cols !== cols) {
      this.map.grid = Array.from({ length: rows }, () => new Uint8Array(cols));
      this.map.brickMasks = Array.from({ length: rows }, () => new Uint8Array(cols));
      this.map.rows = rows;
      this.map.cols = cols;
      this.map.pxW = cols * 16;
      this.map.pxH = rows * 16;
    }
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.map.grid[r][c] = parseInt(str[i], 36);
        this.map.brickMasks[r][c] = parseInt(str[i + 1], 16);
        i += 2;
      }
    }
  }

  buildSnapshot() {
    const r = v => Math.round(v * 100) / 100;
    return {
      st: this.state,
      sg: this.stage,
      lay: this.layoutName,
      fz: this.isFrozen,
      sh: r(this.screenShake),
      wf: this.waterFrame,
      rs: this.enemyReserve.length + this.enemies.length,
      nm: this.playerNames,
      ar: this.map.archetype,
      cy: Math.round(this.camY * 10) / 10,
      dn: Math.round((this.dayTime || 0) * 10) / 10,
      ca: this.map.chunkArchetypes || null,
      tu: this.turrets.map(t => [t.x, t.y, t.dir, t.alive ? 1 : 0, r(t.flash)]),
      sl: this.shells.map(s => [r(s.fx), r(s.fy), r(s.tx), r(s.ty), r(s.t), s.dur]),
      mn: this.mines.map(m => [r(m.x), r(m.y), r(m.arm)]),
      wo: this.worldShift,
      cq: this.layout.conquest ? [this.distanceRows, this.citiesCaptured] : null,
      cs: this.cstats,
      up: this.upgrades,
      uc: this.state === 'UPGRADE' ? this.upgradeChoices : null,
      ct: this.cities.map(c => [c.id, c.x, c.y, c.hp, c.maxHp, c.alive ? 1 : 0, c.captured ? 1 : 0, c.owner, c.zone.x, c.zone.y, c.zone.w, c.zone.h, c.name, r(c.alarm), c.lampDead ? 1 : 0]),
      no: this.localNightOpts,
      fl: this.flares.map(f => [r(f.x), r(f.y), r(f.t), f.dur]),
      b: this.bases.map(b => [b.x, b.y, b.alive, r(b.shovelTimer), b.shovelFlashing, b.hp]),
      p: this.players.map(p => ({
        x: r(p.x), y: r(p.y), direction: p.direction, tier: p.tier, trackAnim: p.trackAnim, trackPos: r(p.trackPos),
        shieldTimer: r(p.shieldTimer), shieldPhase: r(p.shieldPhase), hasBoat: p.hasBoat, dead: p.dead,
        frozenTimer: r(p.frozenTimer), recoil: r(p.recoil), muzzleFlash: r(p.muzzleFlash),
        lastBarrelSide: p.lastBarrelSide, lives: p.lives, score: p.score, kills: p.kills,
        moving: p.moving, index: p.index, spawnX: p.spawnX, spawnY: p.spawnY, w: p.w, h: p.h, armor: p.armor || 0,
        lightsOff: !!p.lightsOff
      })),
      e: this.enemies.map(e => ({
        x: r(e.x), y: r(e.y), direction: e.direction, type: e.type, trackAnim: e.trackAnim, trackPos: r(e.trackPos),
        isFlashing: e.isFlashing, hp: e.hp, hasBoat: e.hasBoat, recoil: r(e.recoil),
        muzzleFlash: r(e.muzzleFlash), moving: e.moving, w: e.w, h: e.h, ghostTimer: r(e.ghostTimer || 0),
        isBoss: !!e.isBoss, maxHp: e.maxHp
      })),
      bu: this.bullets.map(b => ({ x: r(b.x), y: r(b.y), direction: b.direction, owner: b.owner, speed: b.speed })),
      pu: this.powerups.map(p => ({ x: p.x, y: p.y, type: p.type, life: r(Math.min(p.life, 999)), blinkTimer: r(p.blinkTimer) })), // Infinity is not JSON
      ex: this.explosions.map(e => ({ x: r(e.x), y: r(e.y), large: e.large, timer: r(e.timer), duration: e.duration })),
      sa: this.spawnAnimations.map(s => ({ x: s.x, y: s.y, phase: r(s.phase) })),
      fs: this.floatingScores.map(f => ({
        x: r(f.x), y: r(f.y), score: f.score, text: f.text, color: f.color,
        rise: f.rise, timer: r(f.timer), duration: f.duration
      }))
    };
  }

  // Guest: mirror the host's world (render-only copies of the entities)
  applySnapshot(s) {
    const make = (cls, data) => Object.assign(Object.create(cls.prototype), data);
    if (s.lay && s.lay !== this.layoutName && MapGenerator.LAYOUTS[s.lay]) this.setLayout(s.lay);
    this.state = s.st;
    this.stage = s.sg;
    this.isFrozen = s.fz;
    this.screenShake = s.sh;
    this.waterFrame = s.wf;
    if (Array.isArray(s.nm)) {
      this.playerNames = s.nm.slice(0, MAX_PLAYERS).map((n, i) => cleanPlayerName(n) || this.defaultName(i));
    }
    if (s.map) this.decodeMap(s.map);
    if (typeof s.ar === 'string') this.map.archetype = s.ar;
    if (typeof s.wo === 'number') {
      // The host pushed new land on top: move our own visuals with the world
      if (this.lastWorldShift !== undefined && s.wo > this.lastWorldShift) this.shiftVisuals(s.wo - this.lastWorldShift);
      this.lastWorldShift = s.wo;
    }
    if (typeof s.cy === 'number') this.camY = s.cy;
    if (typeof s.dn === 'number') this.dayTime = s.dn;
    if (Array.isArray(s.ca)) this.map.chunkArchetypes = s.ca;
    if (s.no && typeof s.no === 'object') this.hostNightOpts = s.no;
    if (Array.isArray(s.fl)) this.flares = s.fl.map(([x, y, t, dur]) => ({ x, y, t, dur }));
    if (Array.isArray(s.sl)) this.shells = s.sl.map(([fx, fy, tx, ty, t, dur]) => ({ fx, fy, tx, ty, t, dur }));
    if (Array.isArray(s.mn)) this.mines = s.mn.map(([x, y, arm]) => ({ x, y, arm }));
    if (Array.isArray(s.tu)) {
      this.turrets = s.tu.map(([x, y, dir, alive, flash]) => ({ x, y, w: 24, h: 24, dir, alive: !!alive, flash }));
    }
    if (Array.isArray(s.cq)) [this.distanceRows, this.citiesCaptured] = s.cq;
    if (s.cs && typeof s.cs === 'object') this.cstats = { time: +s.cs.time || 0, fortresses: s.cs.fortresses | 0, bosses: s.cs.bosses | 0 };
    if (s.up && typeof s.up === 'object') this.upgrades = s.up;
    if (Array.isArray(s.uc)) this.upgradeChoices = s.uc.filter(id => UPGRADES.some(x => x.id === id));
    if (Array.isArray(s.ct)) {
      this.cities = s.ct.map(([id, x, y, hp, maxHp, alive, captured, owner, zx, zy, zw, zh, name, alarm, lampDead]) => ({
        id, x, y, w: 32, h: 32, hp, maxHp, alive: !!alive, captured: !!captured, owner,
        zone: { x: zx, y: zy, w: zw, h: zh }, spawns: [], name: String(name || '').toUpperCase().replace(/[^A-ZА-ЯЁ0-9 \-]/g, '').slice(0, 12) || 'CITY', alarm: alarm || 0, lampDead: !!lampDead
      }));
    }
    if (Array.isArray(s.b)) {
      this.bases = s.b.map(([x, y, alive, shovelTimer, shovelFlashing, hp]) =>
        Object.assign(new BaseEagle(x, y), { alive, shovelTimer, shovelFlashing, hp: hp === undefined ? 2 : hp }));
      this.map.fortOwner.clear();
      this.bases.forEach(base => base.walls.forEach(pt => this.map.fortOwner.set(pt.y * this.map.cols + pt.x, base)));
    }
    this.players = s.p.map(d => make(PlayerTank, d));
    this.playerCount = this.players.length;
    const cab = document.getElementById('arcade-cabinet');
    const quad = this.layoutName === 'big' || this.players.length > 2;
    if (cab.classList.contains('big-mode') !== quad) {
      cab.classList.toggle('big-mode', quad);
      this.fitToScreen();
    }
    document.getElementById('arcade-cabinet').classList.toggle('two-players', this.players.length > 1);
    this.enemies = s.e.map(d => make(EnemyTank, d));
    this.bullets = s.bu.map(d => make(Bullet, d));
    this.powerups = s.pu.map(d => make(PowerUpItem, d));
    this.explosions = s.ex.map(d => make(ExplosionEffect, d));
    this.floatingScores = s.fs.map(d => make(FloatingScore, d));
    this.spawnAnimations = s.sa;

    // Tread marks are cosmetic: draw them locally
    this.players.concat(this.enemies).forEach(t => {
      if (t.moving && !t.dead && Math.random() < 0.08) this.recordTreadMark(t);
    });

    if (s.rs !== this.netReserve) {
      this.renderReserveIcons(this.netReserve !== undefined, s.rs);
      this.netReserve = s.rs;
    }
    this.updateHUD();
  }

  applyNetUi(u) {
    if (u.u === 'stage') {
      this.stageToken++;
      this.clearTallyTimers();
      document.getElementById('game-overlay').classList.add('hidden');
      document.getElementById('tally-screen').classList.add('hidden');
      this.gameOverText = null;
      this.particles = [];
      this.treadMarks = [];
      this.rings = [];
      this.decals = [];
      this.parts = [];
      this.lights = [];
      this.treeRustle.clear();
      this.stage = u.stage;
      this.state = 'CURTAIN';
      this.showStageCurtain(u.stage);
      sound.stopEngineHum();
      sound.playStageStart(() => {});
    } else if (u.u === 'upgrade') {
      this.upgradeChoices = Array.isArray(u.choices) ? u.choices.filter(id => UPGRADES.some(x => x.id === id)) : null;
      this.upgradeIndex = 0;
    } else if (u.u === 'open') {
      this.openStageCurtain();
    } else if (u.u === 'tally') {
      this.triggerStageComplete();
    } else if (u.u === 'gameover') {
      this.triggerGameOver();
    }
  }

  // Guest: send local controls to the host (on change + keep-alive)
  updateGuest(dt) {
    const input = this.readInput(0);
    const key = input.dir + '|' + input.fire + '|' + this.net.taps;
    this.net.inputTimer -= dt;
    if (key !== this.net.lastInput || this.net.inputTimer <= 0) {
      this.net.send({ t: 'in', dir: input.dir, fire: input.fire, taps: this.net.taps });
      this.net.lastInput = key;
      this.net.inputTimer = 0.2;
    }

    const local = this.players[this.localIndex];
    if (this.state !== 'PLAYING') sound.stopEngineHum();
    else if (local && !local.dead && local.frozenTimer <= 0) sound.setEngineState(!!input.dir, true);
  }

  // -------------------------------------------------------------
  // VISUAL FX & PARTICLES HELPERS
  // -------------------------------------------------------------
  addScreenShake(intensity = 3) {
    this.screenShake = Math.min(this.screenShake + intensity, 8);
  }

  flashScreen() {
    const container = document.getElementById('canvas-container');
    container.classList.remove('flash');
    void container.offsetWidth;
    container.classList.add('flash');
    clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => container.classList.remove('flash'), 400);
  }

  spawnRing(x, y, color, maxR = 22, dur = 0.45) {
    this.rings.push({ x, y, color, maxR, dur, t: 0 });
  }

  spawnBrickDebris(x, y) {
    const colors = ['#d64d27', '#ff7a45', '#b83818', '#73210b'];
    this.addRubble(x, y);
    // Chunky pieces that tumble out and settle
    for (let i = 0; i < 4; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 25 + Math.random() * 40;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 2.5 + Math.random() * 1.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0.6 + Math.random() * 0.4,
        maxLife: 1.0,
        drag: 5
      });
    }
    // Dust
    this.particles.push({ x, y, vx: 0, vy: -6, size: 3, color: 'rgba(150, 110, 90, 0.35)',
      life: 0.6, maxLife: 0.6, grow: 9, isSmoke: true });
    for (let i = 0; i < 7; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 20 + Math.random() * 50;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 1.5 + Math.random() * 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0.35 + Math.random() * 0.25,
        maxLife: 0.5
      });
    }
  }

  spawnRicochetSparks(x, y) {
    const colors = ['#ffffff', '#fff59d', '#ffea00', '#ff9100'];
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 40 + Math.random() * 80;
      this.particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 1 + Math.random() * 1.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0.2 + Math.random() * 0.2,
        maxLife: 0.4
      });
    }
  }

  // Hull fragments, embers and smoke when a tank is destroyed (+ a scorch mark and a flash)
  spawnTankDebris(x, y, hullColors) {
    this.addScorch(x, y, 15 + Math.random() * 5);
    this.addLight(x, y, 80, 0.5, '255, 170, 80');
    this.scatterTankParts(x, y, hullColors);
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 50 + Math.random() * 90;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 2 + Math.random() * 2,
        color: hullColors[Math.floor(Math.random() * hullColors.length)],
        life: 0.5 + Math.random() * 0.4,
        maxLife: 0.9,
        drag: 3
      });
    }
    const embers = ['#ffffff', '#ffe082', '#ffab00', '#ff6d00'];
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 70 + Math.random() * 120;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 1 + Math.random() * 1.5,
        color: embers[Math.floor(Math.random() * embers.length)],
        life: 0.25 + Math.random() * 0.35,
        maxLife: 0.6,
        drag: 2
      });
    }
    for (let i = 0; i < 5; i++) {
      this.spawnSmokePuff(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14, true);
    }
  }

  spawnMuzzleSparks(x, y, direction) {
    const d = DIRS[direction];
    this.addLight(x, y, 34, 0.09, '255, 220, 150');
    const base = Math.atan2(d.dy, d.dx);
    const colors = ['#ffffff', '#fff59d', '#ffd54f'];
    for (let i = 0; i < 5; i++) {
      const angle = base + (Math.random() - 0.5) * 1.1;
      const spd = 60 + Math.random() * 70;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 1 + Math.random(),
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0.08 + Math.random() * 0.1,
        maxLife: 0.18
      });
    }
  }

  spawnSparkles(x, y, colors, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 30 + Math.random() * 60;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 1.5 + Math.random() * 1.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0.4 + Math.random() * 0.3,
        maxLife: 0.7,
        drag: 2.5,
        isSparkle: true
      });
    }
  }

  spawnSmokePuff(x, y, heavy = false) {
    this.particles.push({
      x: x + (Math.random() - 0.5) * 4,
      y: y + (Math.random() - 0.5) * 4,
      vx: (Math.random() - 0.5) * 10,
      vy: -15 - Math.random() * 15,
      size: heavy ? 4 + Math.random() * 3 : 3 + Math.random() * 3,
      color: heavy ? 'rgba(40, 42, 50, 0.55)' : 'rgba(50, 55, 65, 0.4)',
      life: heavy ? 1.1 : 0.5,
      maxLife: heavy ? 1.1 : 0.5,
      grow: heavy ? 7 : 5,
      isSmoke: true
    });
  }

  // Smoke particle that is never sent over the network: each computer makes its own
  // (used for effects that every computer computes locally, e.g. damage smoke)
  addSmokeParticle(x, y, heavy = false) {
    this.particles.push({
      x: x + (Math.random() - 0.5) * 4,
      y: y + (Math.random() - 0.5) * 4,
      vx: (Math.random() - 0.5) * 10,
      vy: -15 - Math.random() * 15,
      size: heavy ? 4 + Math.random() * 3 : 3 + Math.random() * 3,
      color: heavy ? 'rgba(40, 42, 50, 0.55)' : 'rgba(50, 55, 65, 0.4)',
      life: heavy ? 1.1 : 0.5,
      maxLife: heavy ? 1.1 : 0.5,
      grow: heavy ? 7 : 5,
      isSmoke: true
    });
  }

  // -------------------------------------------------------------
  // BATTLE SCARS: scorch marks and rubble that stay for the whole stage
  // -------------------------------------------------------------
  // Keeps at most 40 scorch marks and 60 rubble piles (oldest fade out first)
  addDecal(decal) {
    this.decals.push(decal);
    const cap = decal.type === 'scorch' ? 40 : 60;
    const same = this.decals.filter(d => d.type === decal.type);
    if (same.length > cap) this.decals.splice(this.decals.indexOf(same[0]), 1);
  }

  addScorch(x, y, radius) {
    const blobs = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * (0.25 + Math.random() * 0.45);
      blobs.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: radius * (0.35 + Math.random() * 0.3) });
    }
    this.addDecal({ type: 'scorch', x, y, r: radius, blobs, rot: Math.random() * Math.PI * 2 });
  }

  addRubble(x, y) {
    const bits = [];
    const colors = ['#8f3a1e', '#6e2a14', '#a5482a', '#4a2416'];
    for (let i = 0; i < 6; i++) {
      bits.push({
        dx: (Math.random() - 0.5) * 12,
        dy: (Math.random() - 0.5) * 12,
        s: 0.8 + Math.random() * 1.4,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
    }
    this.addDecal({ type: 'rubble', x, y, bits });
  }

  renderDecals() {
    if (this.decals.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    this.decals.forEach(d => {
      if (d.type === 'scorch') {
        d.blobs.forEach(b => {
          const g = ctx.createRadialGradient(d.x + b.dx, d.y + b.dy, 0, d.x + b.dx, d.y + b.dy, b.r);
          g.addColorStop(0, 'rgba(8, 6, 4, 0.42)');
          g.addColorStop(1, 'rgba(8, 6, 4, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(d.x + b.dx, d.y + b.dy, b.r, 0, Math.PI * 2);
          ctx.fill();
        });
        // Crater rim and burnt cracks
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r * 0.35, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 140, 60, 0.12)';
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const a = d.rot + k * 1.26;
          ctx.moveTo(d.x + Math.cos(a) * d.r * 0.35, d.y + Math.sin(a) * d.r * 0.35);
          ctx.lineTo(d.x + Math.cos(a) * d.r * 0.8, d.y + Math.sin(a) * d.r * 0.8);
        }
        ctx.stroke();
      } else {
        d.bits.forEach(b => {
          ctx.fillStyle = b.color;
          ctx.fillRect(d.x + b.dx, d.y + b.dy, b.s, b.s);
        });
      }
    });
    ctx.restore();
  }

  // -------------------------------------------------------------
  // LIGHT: short flashes from shots, glow of explosions and shells
  // -------------------------------------------------------------
  addLight(x, y, radius, duration, rgb) {
    this.lights.push({ x, y, radius, duration, rgb, t: 0 });
    if (this.lights.length > 40) this.lights.shift();
  }

  renderLights() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, alpha, rgb) => {
      if (alpha <= 0.01 || r <= 0) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      g.addColorStop(0.4, `rgba(${rgb}, ${alpha * 0.45})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    this.lights.forEach(l => {
      const p = l.t / l.duration;
      glow(l.x, l.y, l.radius * (0.8 + p * 0.4), 0.55 * (1 - p), l.rgb);
    });
    // Explosions light up the surroundings while they burn
    this.explosions.forEach(e => {
      const p = Math.min(1, e.timer / e.duration);
      glow(e.x, e.y, e.large ? 70 : 34, (e.large ? 0.5 : 0.3) * (1 - p), '255, 150, 60');
    });
    // Burning signal flares
    this.flares.forEach(f => glow(f.x, f.y, 60, 0.35 * (1 - f.t / f.dur), '255, 245, 200'));
    // Shells carry a faint glow
    this.bullets.forEach(b => glow(b.x + 3, b.y + 3, 12, 0.22, b.owner === 'player' ? '255, 220, 120' : '255, 120, 80'));
    ctx.restore();
  }

  // -------------------------------------------------------------
  // WEATHER per map type (purely visual, computed on every computer)
  // -------------------------------------------------------------
  initWeather(archetype) {
    this.weatherFor = archetype;
    this.weather = [];
    const W = this.map.pxW;
    const H = this.viewH();
    const kind = { WINTER_ICE: 'snow', FOREST_AMBUSH: 'leaves', RIVER_CROSSING: 'mist' }[archetype] || null;
    this.weatherKind = kind;
    const area = W / 416;
    if (kind === 'snow') {
      for (let i = 0; i < 110 * area; i++) {
        this.weather.push({ x: Math.random() * W, y: Math.random() * H, s: 0.5 + Math.random() * 1.3,
          v: 12 + Math.random() * 18, ph: Math.random() * 6.28 });
      }
    } else if (kind === 'leaves') {
      const colors = ['#5fbf3f', '#9ccc3d', '#d4b73a', '#3f9a35', '#c98a2e'];
      for (let i = 0; i < 26 * area; i++) {
        this.weather.push({ x: Math.random() * W, y: Math.random() * H, s: 1.2 + Math.random() * 1.2,
          v: 8 + Math.random() * 10, ph: Math.random() * 6.28, rot: Math.random() * 6.28,
          color: colors[Math.floor(Math.random() * colors.length)] });
      }
    } else if (kind === 'mist') {
      for (let i = 0; i < 6 * area; i++) {
        this.weather.push({ x: Math.random() * W, y: Math.random() * H, r: 40 + Math.random() * 50,
          v: 4 + Math.random() * 6, a: 0.05 + Math.random() * 0.05 });
      }
    }
  }

  updateWeather(dt) {
    if (this.map.archetype !== this.weatherFor) this.initWeather(this.map.archetype);
    const W = this.map.pxW;
    const H = this.viewH();
    this.weather.forEach(w => {
      if (this.weatherKind === 'mist') {
        w.x += w.v * dt;
        if (w.x - w.r > W) w.x = -w.r;
        return;
      }
      w.ph += dt * (this.weatherKind === 'snow' ? 1.6 : 2.4);
      w.y += w.v * dt;
      w.x += Math.sin(w.ph) * (this.weatherKind === 'snow' ? 6 : 14) * dt;
      if (w.rot !== undefined) w.rot += dt * 2;
      if (w.y > H + 4) { w.y = -4; w.x = Math.random() * W; }
      if (w.x < -4) w.x += W + 8;
      if (w.x > W + 4) w.x -= W + 8;
    });
  }

  renderWeather() {
    if (!this.weather.length) return;
    const ctx = this.ctx;
    ctx.save();
    if (this.weatherKind === 'snow') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      this.weather.forEach(w => {
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.s * 0.6, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (this.weatherKind === 'leaves') {
      this.weather.forEach(w => this.drawLeaf(ctx, w.x, w.y, w.s, w.rot, w.color, 0.85));
    } else if (this.weatherKind === 'mist') {
      this.weather.forEach(w => {
        const g = ctx.createRadialGradient(w.x, w.y, 0, w.x, w.y, w.r);
        g.addColorStop(0, `rgba(210, 230, 255, ${w.a})`);
        g.addColorStop(1, 'rgba(210, 230, 255, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(w.x, w.y, w.r, w.r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();
  }

  drawLeaf(ctx, x, y, size, rot, color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(rot * 1.7))); // flutter
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, size, size * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------
  // LIVING TREES: canopy shakes when a tank drives under it; shells knock leaves off
  // -------------------------------------------------------------
  addLeafParticle(x, y, burst = false) {
    const colors = ['#4fbf45', '#2f9a35', '#86d65e', '#c9b93a'];
    this.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * (burst ? 60 : 16),
      vy: (burst ? -10 : 4) + Math.random() * 14,
      size: 1 + Math.random() * 1.1,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 0.9 + Math.random() * 0.8,
      maxLife: 1.7,
      drag: burst ? 2.5 : 0.8,
      isLeaf: true,
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 8,
      sway: 10 + Math.random() * 10
    });
  }

  // Trees cut down by a heavy shell burst into leaves (sent to online guests)
  spawnLeafBurst(x, y) {
    for (let i = 0; i < 14; i++) this.addLeafParticle(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14, true);
  }

  treeTilesUnder(t, fn) {
    const c0 = Math.max(0, Math.floor(t.x / 16));
    const c1 = Math.min(this.map.cols - 1, Math.floor((t.x + (t.w || 26) - 1) / 16));
    const r0 = Math.max(0, Math.floor(t.y / 16));
    const r1 = Math.min(this.map.rows - 1, Math.floor((t.y + (t.h || 26) - 1) / 16));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (this.map.grid[r][c] === MapGenerator.TILES.TREES) fn(r, c);
      }
    }
  }

  // Local, per-frame visual effects: rustling trees, leaves from shells, damage smoke & sparks
  updateLivingWorld(dt) {
    if (!this.map.grid) return;
    sound.setEnemyEngine(this.state === 'PLAYING' && !this.isFrozen ? this.enemies.filter(e => e.moving && !e.dead).length : 0);
    for (const [key, left] of this.treeRustle) {
      if (left - dt <= 0) this.treeRustle.delete(key);
      else this.treeRustle.set(key, left - dt);
    }
    if (this.state !== 'PLAYING') return;

    this.players.concat(this.enemies).forEach(t => {
      if (t.dead || !t.moving) return;
      const d = DIRS[t.direction] || DIRS.UP;
      const cx = t.x + 13;
      const cy = t.y + 13;

      // Exhaust puffs from the rear of the hull
      if (Math.random() < dt * 7) {
        this.particles.push({
          x: cx - d.dx * 13 + (Math.random() - 0.5) * 4, y: cy - d.dy * 13 + (Math.random() - 0.5) * 4,
          vx: -d.dx * 12 + (Math.random() - 0.5) * 6, vy: -d.dy * 12 + (Math.random() - 0.5) * 6,
          size: 1.2 + Math.random(), color: 'rgba(70, 75, 85, 0.3)', life: 0.45, maxLife: 0.45, grow: 6, isSmoke: true
        });
      }

      // Boat wake: ripples spreading behind a tank crossing water
      if (t.hasBoat) {
        const r = Math.floor(cy / 16);
        const c = Math.floor(cx / 16);
        if (this.map.grid[r] && this.map.grid[r][c] === MapGenerator.TILES.WATER && Math.random() < dt * 12) {
          this.particles.push({
            x: cx - d.dx * 12, y: cy - d.dy * 12, vx: 0, vy: 0, size: 3, color: 'rgba(220, 240, 255, 0.6)',
            life: 0.8, maxLife: 0.8, isRipple: true, axisX: d.dx !== 0
          });
        }
      }

      this.treeTilesUnder(t, (r, c) => {
        this.treeRustle.set(r * this.map.cols + c, 0.4);
        if (Math.random() < 0.04) this.addLeafParticle(c * 16 + Math.random() * 16, r * 16 + Math.random() * 16);
      });
    });

    this.bullets.forEach(b => {
      const c = Math.floor((b.x + 3) / 16);
      const r = Math.floor((b.y + 3) / 16);
      if (r >= 0 && r < this.map.rows && c >= 0 && c < this.map.cols &&
          this.map.grid[r][c] === MapGenerator.TILES.TREES) {
        this.treeRustle.set(r * this.map.cols + c, 0.3);
        if (Math.random() < 0.35) this.addLeafParticle(b.x + 3, b.y + 3, true);
      }
    });

    // Damaged armour tanks smoke more the more hits they took
    this.enemies.forEach(e => {
      if (e.dead || e.type !== 'armor' || e.hp >= 4) return;
      if (Math.random() < dt * (4 - Math.max(1, e.hp)) * 3) this.addSmokeParticle(e.x + 13, e.y + 13, e.hp <= 1);
    });

    // A hit Eagle sparks from its cracks
    this.bases.forEach(base => {
      if (!base.alive || base.hp >= 2) return;
      if (Math.random() < dt * 4) {
        const x = base.x + 8 + Math.random() * 16;
        const y = base.y + 6 + Math.random() * 18;
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          this.particles.push({ x, y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40 - 10, size: 1, color: i ? '#ffd54f' : '#ffffff',
            life: 0.25, maxLife: 0.25, drag: 3 });
        }
      }
      if (Math.random() < dt * 1.5) this.addSmokeParticle(base.x + 16, base.y + 10);
    });
  }

  // Living Eagle: a soft golden aura that breathes...
  renderEagleGlow(base) {
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    const cx = base.x + 16;
    const cy = base.y + 14;
    const pulse = 0.5 + Math.sin(t * 2.2) * 0.5;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 22 + pulse * 4);
    g.addColorStop(0, `rgba(255, 215, 90, ${0.22 + pulse * 0.12})`);
    g.addColorStop(1, 'rgba(255, 215, 90, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 28, cy - 28, 56, 56);
  }

  // ...a light sweep across the statue every few seconds, and rising sparkles
  renderEagleShine(base) {
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    const cycle = (t + base.x * 0.01) % 4;
    if (cycle < 0.7) {
      const p = cycle / 0.7;
      const sx = base.x - 10 + p * 52;
      ctx.save();
      ctx.beginPath();
      ctx.rect(base.x + 2, base.y + 2, 28, 22);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(sx - 6, base.y, sx + 6, base.y + 12);
      g.addColorStop(0, 'rgba(255, 240, 180, 0)');
      g.addColorStop(0.5, 'rgba(255, 240, 180, 0.45)');
      g.addColorStop(1, 'rgba(255, 240, 180, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(sx - 6, base.y);
      ctx.lineTo(sx + 2, base.y);
      ctx.lineTo(sx - 6, base.y + 26);
      ctx.lineTo(sx - 14, base.y + 26);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Two tiny sparkles orbiting the crest
    ctx.save();
    ctx.fillStyle = 'rgba(255, 245, 200, 0.9)';
    for (let i = 0; i < 2; i++) {
      const a = t * 1.6 + i * Math.PI;
      const x = base.x + 16 + Math.cos(a) * 12;
      const y = base.y + 10 + Math.sin(a) * 4;
      const s = 0.6 + Math.max(0, Math.sin(t * 5 + i * 2)) * 0.9;
      ctx.fillRect(x - s, y - 0.3, s * 2, 0.6);
      ctx.fillRect(x - 0.3, y - s, 0.6, s * 2);
    }
    ctx.restore();
  }

  // Cracks over an Eagle that has taken its first hit
  renderBaseCracks(base) {
    const ctx = this.ctx;
    const x = base.x;
    const y = base.y;
    ctx.save();
    ctx.lineCap = 'round';
    const lines = [
      [[16, 4], [13, 11], [17, 16], [12, 24]],
      [[13, 11], [7, 13]],
      [[17, 16], [24, 19], [27, 26]],
      [[20, 7], [23, 12]]
    ];
    [['rgba(20, 8, 4, 0.85)', 1.3], ['rgba(255, 210, 140, 0.35)', 0.5]].forEach(([color, width], pass) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      lines.forEach(pts => pts.forEach(([px, py], i) => {
        const ox = pass ? -0.4 : 0;
        if (i === 0) ctx.moveTo(x + px + ox, y + py + ox);
        else ctx.lineTo(x + px + ox, y + py + ox);
      }));
      ctx.stroke();
    });
    ctx.restore();
  }

  // -------------------------------------------------------------
  // WRECKAGE: small tank parts fly out of an explosion and stay on the ground.
  // Purely decorative: no collision, tanks and shells pass over them.
  // -------------------------------------------------------------
  scatterTankParts(x, y, hullColors) {
    // Weighted mix of parts: armour pieces and tracks most often, rarer bits for variety
    const kinds = [
      'plate', 'plate', 'plate', 'bentPlate', 'bentPlate', 'rivetPlate',
      'link', 'link', 'chain', 'chain', 'wheel', 'wheel', 'gear',
      'hatch', 'barrel', 'pipe', 'antenna', 'bolt', 'bolt', 'shard', 'shard', 'spring'
    ];
    const count = 9 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 50 + Math.random() * 95;
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const paint = hullColors[Math.floor(Math.random() * Math.min(3, hullColors.length))];
      this.parts.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 18,
        kind,
        color: this.scorchColor(paint, Math.random() * 0.55), // Paint, more or less burnt
        size: 0.8 + Math.random() * 0.5,           // Each piece a little different
        heat: kind === 'shard' ? 0 : 1.6 + Math.random() * 1.2, // Glows hot for a moment after landing
        smoking: Math.random() < 0.35,             // Leaves a smoke trail while flying
        lift: 1,          // 1 = in the air (bigger), 0 = lying on the ground
        settled: false
      });
    }
    if (this.parts.length > 160) this.parts.splice(0, this.parts.length - 160);
  }

  // Darken a '#rrggbb' colour towards soot by amount 0..1
  scorchColor(hex, amount) {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return hex;
    const k = 1 - amount;
    const ch = i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k + 18 * amount);
    return `rgb(${ch(1)}, ${ch(3)}, ${ch(5)})`;
  }

  updateParts(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      if (p.settled) {
        if (p.heat > 0) {
          p.heat -= dt;
          if (p.smoking && Math.random() < dt * 3) this.addSmokeParticle(p.x, p.y);
        }
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const f = Math.max(0, 1 - 4.5 * dt);
      p.vx *= f;
      p.vy *= f;
      p.vr *= f;
      p.lift = Math.max(0, p.lift - dt * 2.2);
      if (p.smoking && Math.random() < dt * 14) this.addSmokeParticle(p.x, p.y);
      if (Math.hypot(p.vx, p.vy) < 4 && p.lift <= 0) {
        p.settled = true;
        // Parts that land in water sink; parts off the field are dropped
        const c = Math.floor(p.x / 16);
        const r = Math.floor(p.y / 16);
        const offField = r < 0 || r >= this.map.rows || c < 0 || c >= this.map.cols;
        if (offField || this.map.grid[r][c] === MapGenerator.TILES.WATER) {
          if (!offField) this.addSmokeParticle(p.x, p.y);
          this.parts.splice(i, 1);
        }
      }
    }
  }

  renderParts() {
    if (!this.parts.length) return;
    const ctx = this.ctx;
    ctx.save();
    this.parts.forEach(p => {
      const scale = p.size * (1 + p.lift * 0.6);
      ctx.save();
      ctx.translate(p.x, p.y);

      // Shadow, offset more while the part is still in the air
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.beginPath();
      ctx.ellipse(0.8 + p.lift * 3, 1 + p.lift * 4, 3 * scale, 1.8 * scale, 0, 0, Math.PI * 2);
      ctx.fill();

      // Hot glow under freshly landed pieces
      if (p.settled && p.heat > 0) {
        const a = Math.min(1, p.heat / 1.6) * 0.45;
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 6 * scale);
        glow.addColorStop(0, `rgba(255, 130, 40, ${a})`);
        glow.addColorStop(1, 'rgba(255, 130, 40, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, 6 * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.rotate(p.rot);
      ctx.scale(scale, scale);
      this.drawPart(ctx, p);

      ctx.restore();
    });
    ctx.restore();
  }

  // One wreckage piece, drawn around (0, 0) in logical px (a tank is 26 px wide)
  drawPart(ctx, p) {
    const dark = '#1d2128';
    const steel = '#9aa5b4';
    const light = 'rgba(255, 255, 255, 0.4)';
    const shade = 'rgba(0, 0, 0, 0.45)';
    switch (p.kind) {
      case 'plate':        // Flat armour panel
        ctx.fillStyle = p.color;
        ctx.fillRect(-2.8, -1.8, 5.6, 3.6);
        ctx.fillStyle = light;
        ctx.fillRect(-2.8, -1.8, 5.6, 0.7);
        ctx.fillStyle = shade;
        ctx.fillRect(-2.8, 1.1, 5.6, 0.7);
        break;
      case 'bentPlate':    // Torn, bent armour
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-3, -1.5); ctx.lineTo(1, -2.2); ctx.lineTo(3, 0.4); ctx.lineTo(0.4, 2); ctx.lineTo(-2.4, 1.2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = shade;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(-1, -1.8); ctx.lineTo(0.2, 1.8);
        ctx.stroke();
        break;
      case 'rivetPlate':   // Panel with rivets
        ctx.fillStyle = p.color;
        ctx.fillRect(-2.6, -2.2, 5.2, 4.4);
        ctx.fillStyle = '#e0e6ee';
        [[-1.8, -1.4], [1.8, -1.4], [-1.8, 1.4], [1.8, 1.4]].forEach(([rx, ry]) => ctx.fillRect(rx - 0.35, ry - 0.35, 0.7, 0.7));
        break;
      case 'link':         // Single track shoe
        ctx.fillStyle = dark;
        ctx.fillRect(-2.2, -0.9, 4.4, 1.8);
        ctx.fillStyle = 'rgba(190, 200, 215, 0.65)';
        ctx.fillRect(-1.9, -0.75, 3.8, 0.5);
        ctx.fillRect(-0.3, -0.9, 0.6, 1.8);
        break;
      case 'chain':        // Several track shoes still joined
        for (let k = -1; k <= 1; k++) {
          ctx.save();
          ctx.translate(k * 2.1, k * 0.4);
          ctx.rotate(k * 0.25);
          ctx.fillStyle = dark;
          ctx.fillRect(-0.9, -2, 1.8, 4);
          ctx.fillStyle = 'rgba(190, 200, 215, 0.6)';
          ctx.fillRect(-0.75, -1.8, 0.5, 3.6);
          ctx.restore();
        }
        break;
      case 'wheel':        // Road wheel
        ctx.fillStyle = '#15191f';
        ctx.beginPath();
        ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#4a525e';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = steel;
        ctx.beginPath();
        ctx.arc(0, 0, 0.7, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'gear':         // Drive sprocket with teeth
        ctx.fillStyle = '#3a414c';
        ctx.beginPath();
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const rr = k % 2 ? 2.1 : 2.8;
          if (k === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = steel;
        ctx.beginPath();
        ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'hatch':        // Round turret hatch
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = shade;
        ctx.lineWidth = 0.6;
        ctx.stroke();
        ctx.fillStyle = light;
        ctx.fillRect(-1.6, -0.3, 3.2, 0.6); // handle
        break;
      case 'barrel':       // Broken piece of the gun barrel
        ctx.fillStyle = p.color;
        ctx.fillRect(-4.5, -0.9, 9, 1.8);
        ctx.fillStyle = light;
        ctx.fillRect(-4.5, -0.9, 9, 0.5);
        ctx.fillStyle = dark;
        ctx.fillRect(3.6, -0.9, 0.9, 1.8);
        // Jagged broken end
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-4.5, -0.9); ctx.lineTo(-5.4, -0.3); ctx.lineTo(-4.8, 0.2); ctx.lineTo(-5.3, 0.9); ctx.lineTo(-4.5, 0.9);
        ctx.closePath();
        ctx.fill();
        break;
      case 'pipe':         // Bent exhaust pipe
        ctx.strokeStyle = '#5a6370';
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-3, 1.2);
        ctx.quadraticCurveTo(-0.5, -2.5, 3, -0.6);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 0.4;
        ctx.stroke();
        break;
      case 'antenna':      // Thin whip antenna with a base
        ctx.strokeStyle = '#c8d0da';
        ctx.lineWidth = 0.45;
        ctx.beginPath();
        ctx.moveTo(-4.5, 0);
        ctx.lineTo(4.5, 0.6);
        ctx.stroke();
        ctx.fillStyle = dark;
        ctx.fillRect(-5.2, -0.8, 1.4, 1.6);
        break;
      case 'bolt':         // Nut / bolt
        ctx.fillStyle = '#c3ccd8';
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          if (k === 0) ctx.moveTo(Math.cos(a) * 1.1, Math.sin(a) * 1.1);
          else ctx.lineTo(Math.cos(a) * 1.1, Math.sin(a) * 1.1);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.arc(0, 0, 0.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'shard':        // Headlight glass
        ctx.fillStyle = 'rgba(255, 245, 200, 0.85)';
        ctx.beginPath();
        ctx.moveTo(-1.4, -0.6); ctx.lineTo(0.8, -1.2); ctx.lineTo(1.3, 0.8); ctx.lineTo(-0.6, 1);
        ctx.closePath();
        ctx.fill();
        break;
      case 'spring':       // Suspension spring
        ctx.strokeStyle = '#8f9aa8';
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        for (let k = 0; k <= 8; k++) {
          const xx = -3 + k * 0.75;
          const yy = k % 2 ? -1.1 : 1.1;
          if (k === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
        break;
    }
  }

  // -------------------------------------------------------------
  // CONQUEST MODE: endless land scrolling upwards, enemy cities to capture
  // -------------------------------------------------------------
  viewH() {
    return (this.layout.viewRows || this.layout.rows) * 16;
  }

  initConquest() {
    this.cities = [];
    this.turrets = [];
    this.shells = [];
    this.mines = [];
    this.flares = [];
    this.waterFrozen = false;
    this.extraSpawns = 0;
    this.bossSpawned = {};
    this.cstats = { time: 0, fortresses: 0, bosses: 0 };
    this.lastCaptured = null;
    this.dayTime = 0;
    this.worldShift = 0;
    this.distanceRows = 0;
    this.citiesCaptured = 0;
    this.conquestSpawnTimer = 2.5;
    this.conquestSpawnCount = 0;
    this.camY = this.map.pxH - this.viewH();
    this.camStartY = this.camY;
    this.adoptChunkContent();
  }

  // Cities and ground bonuses that the map just generated
  adoptChunkContent() {
    this.map.newCities.forEach(c => {
      const y0 = c.rowOffset * 16;
      this.cities.push({
        id: ++this.cityIdSeq,
        x: c.hq.x * 16,
        y: y0 + c.hq.y * 16,
        w: 32,
        h: 32,
        hp: c.hp,
        maxHp: c.hp,
        alive: true,
        captured: false,
        owner: null,
        zone: { x: c.zone.x * 16, y: y0 + c.zone.y * 16, w: c.zone.w * 16, h: c.zone.h * 16 },
        spawns: c.spawns.map(s => ({ x: s.x * 16 + 3, y: y0 + s.y * 16 + 3 })),
        garrison: c.garrison,
        spawnTimer: 1.5,
        alarm: 0,
        name: c.name || 'CITY',
        group: c.group || null,   // Fortress: falls when every HQ of the group is destroyed
        boss: !!c.boss,
        bonusTimer: 20 + Math.random() * 15
      });
    });
    const diffStage = 1 + Math.floor(this.distanceRows / 52);
    (this.map.newTurrets || []).forEach(t => {
      this.turrets.push({
        x: t.x * 16 + 4, y: t.y * 16 + 4, w: 24, h: 24, group: t.group,
        hp: 3 + Math.min(3, Math.floor(diffStage / 2)), dir: 'DOWN', cooldown: 1 + Math.random(),
        alive: true, activeBullets: 0, flash: 0
      });
    });
    this.map.newTurrets = [];
    const bonuses = ['star', 'helmet', 'clock', 'grenade', 'tank', 'gun', 'boat'].concat(this.flareAllowed() ? ['flare'] : []);
    this.map.newFinds.forEach(f => {
      const pu = new PowerUpItem(f.x * 16, f.y * 16, bonuses[Math.floor(Math.random() * bonuses.length)]);
      pu.life = Infinity; // Found on the ground: does not expire
      this.powerups.push(pu);
    });
    this.map.newCities = [];
    this.map.newFinds = [];
  }

  // The camera glides to keep the players a little below the middle of the screen
  updateCamera(dt) {
    const alive = this.players.filter(p => !p.dead);
    if (alive.length) {
      const avgY = alive.reduce((s, p) => s + p.y + 13, 0) / alive.length;
      let target = avgY - this.viewH() * 0.58;
      // The screen does not move on while enemies are left behind at its bottom
      const lowest = Math.max(-Infinity, ...this.enemies.filter(e => !e.dead).map(e => e.y + 26));
      if (lowest > -Infinity) target = Math.max(target, lowest + 4 - this.viewH());
      this.camY += (target - this.camY) * Math.min(1, dt * 2.2);
    }
    this.camY = Math.max(0, Math.min(this.map.pxH - this.viewH(), this.camY));
    if (this.camY < 64) this.shiftWorld(this.map.pushChunkOnTop());
    this.distanceRows = Math.max(this.distanceRows, Math.round((this.camStartY - this.camY + this.worldShift) / 16));
    this.map.archetype = this.map.chunkArchetypes[Math.min(2, Math.floor((this.camY + this.viewH() / 2) / (MapGenerator.ROWS * 16)))];
  }

  // New land arrived on top: move everything down by dy and forget what fell off the bottom
  shiftWorld(dy) {
    this.worldShift += dy;
    this.camY += dy;
    const limit = this.map.pxH;
    const move = list => list.forEach(o => { o.y += dy; });
    this.players.forEach(p => { p.y += dy; p.spawnY += dy; });
    [this.enemies, this.bullets, this.powerups, this.explosions, this.floatingScores, this.spawnAnimations].forEach(move);
    this.cities.forEach(c => {
      c.y += dy;
      c.zone.y += dy;
      c.spawns.forEach(s => { s.y += dy; });
    });
    this.enemies.forEach(e => {
      if (e.guard) { e.guard.y += dy; e.guard.cy += dy; }
    });
    this.shiftVisuals(dy);
    this.enemies = this.enemies.filter(e => e.y < limit);
    this.bullets = this.bullets.filter(b => {
      if (b.y < limit) return true;
      if (b.shooter) b.shooter.activeBullets = Math.max(0, b.shooter.activeBullets - 1);
      return false;
    });
    this.powerups = this.powerups.filter(p => p.y < limit);
    this.cities = this.cities.filter(c => c.zone.y < limit);
    if (this.waterFrozen) this.freezeWater(0, MapGenerator.ROWS); // New land arrives frozen at night
    this.turrets.forEach(t => { t.y += dy; });
    this.turrets = this.turrets.filter(t => t.y < limit);
    this.shells.forEach(s => { s.fy += dy; s.ty += dy; });
    this.flares.forEach(f => { f.y += dy; });
    this.mines.forEach(m => { m.y += dy; });
    this.mines = this.mines.filter(m => m.y < limit);
    this.adoptChunkContent();
  }

  // Purely visual things every computer keeps for itself (guests shift them too)
  shiftVisuals(dy) {
    const move = list => list.forEach(o => { o.y += dy; });
    [this.particles, this.treadMarks, this.rings, this.decals, this.parts, this.lights].forEach(move);
    const limit = this.map.pxH + 64;
    this.decals = this.decals.filter(d => d.y < limit);
    this.parts = this.parts.filter(p => p.y < limit);
    this.treadMarks = this.treadMarks.filter(t => t.y < limit);
    this.treeRustle.clear();
  }

  conquestStage() {
    return 1 + Math.floor(this.distanceRows / 52);
  }

  // Enemies come towards the players from the land ahead; more of them the further you get
  handleConquestSpawning(dt) {
    const diff = DIFFICULTY[this.difficulty];
    const roaming = this.enemies.filter(e => !e.homeCity).length +
      this.spawnAnimations.filter(s => !s.homeCity).length;
    const maxRoaming = Math.max(2, Math.min(7, 3 + Math.floor(this.distanceRows / 70)) + diff.extraOnScreen);
    this.conquestSpawnTimer -= dt;
    const called = this.extraSpawns > 0; // Scouts' reinforcements come regardless of the limits
    if (!called && (this.conquestSpawnTimer > 0 || roaming >= maxRoaming)) return;
    if (called) this.extraSpawns--;
    else this.conquestSpawnTimer = Math.max(1.2, 3.4 - this.distanceRows / 220);

    // Just above the top of the screen, on free ground outside captured land
    for (let attempt = 0; attempt < 20; attempt++) {
      const c = Math.floor(Math.random() * (this.map.cols - 1));
      const r = Math.floor((this.camY - 16 - Math.random() * 64) / 16);
      if (r < 0) return;
      const x = c * 16 + 3;
      const y = r * 16 + 3;
      if (this.map.isBlocked(x, y, 26, 26, false, null)) continue;
      if (this.map.isEnclosed(x, y)) continue; // Never inside a pocket in steel or water
      if (this.cities.some(city => city.captured && this.inZone(city, x + 13, y + 13))) continue;
      this.queueConquestEnemy(x, y, null);
      return;
    }
  }

  queueConquestEnemy(x, y, city) {
    // Enemy mix of the "stage" matching the distance travelled; every 7th tank carries a bonus
    if (!this.conquestPool || this.conquestPool.stage !== this.conquestStage()) {
      const stage = this.conquestStage();
      this.conquestPool = { stage, list: MapGenerator.generateEnemyPool(stage, Math.random, 20) };
    }
    let config;
    if (this.enemyReserve.length) {
      config = this.enemyReserve.shift(); // Reinforcements an enemy got from a bonus
    } else if (city) {
      // Garrisons are heavier: armour and power tanks more often
      const roll = Math.random();
      const type = roll < 0.35 ? 'armor' : roll < 0.65 ? 'power' : roll < 0.85 ? 'basic' : 'fast';
      const pts = { basic: 100, fast: 200, power: 300, armor: 400 }[type];
      config = { type, hp: type === 'armor' ? 4 : 1, points: pts, isFlashing: false };
    } else {
      const pick = this.conquestPool.list[Math.floor(Math.random() * this.conquestPool.list.length)];
      config = Object.assign({}, pick, { isFlashing: false });
      // Special conquest tanks appear the further you get
      const roll = Math.random();
      const d = this.distanceRows;
      const on = this.enemyTypes;
      const night = this.nightRule('enemies');
      if (night && Math.random() < 0.3) {
        // Night raiders: fast tanks and scouts
        config = on.scout && Math.random() < 0.4 ? { type: 'scout', hp: 1, points: 150, isFlashing: false }
          : { type: 'fast', hp: 1, points: 200, isFlashing: false };
      } else if (on.scout && d > 20 && roll < 0.12) config = { type: 'scout', hp: 1, points: 150, isFlashing: false };
      else if (on.artillery && d > 30 && roll >= 0.12 && roll < (night ? 0.17 : 0.22)) config = { type: 'artillery', hp: 2, points: 300, isFlashing: false };
      else if (on.miner && d > 50 && roll >= 0.22 && roll < 0.32) config = { type: 'miner', hp: 1, points: 250, isFlashing: false };
    }
    this.conquestSpawnCount++;
    if (this.conquestSpawnCount % 7 === 0) config.isFlashing = true;
    if (config.isFlashing) sound.playBonusAlert();
    this.spawnAnimations.push({ x, y, config, timer: 1.0, phase: 0, homeCity: city ? city.id : null });
  }

  inZone(city, x, y) {
    const z = city.zone;
    return x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;
  }

  // Each city keeps a garrison around its headquarters while the players are near
  updateCities(dt) {
    this.cities.forEach(city => {
      if (!city.alive) return;
      // A fortress sends out its boss once, when the players come close
      if (city.boss && city.group && !this.bossSpawned[city.group] &&
          city.zone.y + city.zone.h > this.camY && city.zone.y < this.camY + this.viewH() - 64) {
        const spot = this.findBossSpot(city.zone);
        if (spot) {
          const { x, y } = spot;
          this.bossSpawned[city.group] = true;
          const hp = 20 + 2 * this.conquestStage();
          this.spawnAnimations.push({ x, y, config: { type: 'boss', hp, points: 3000, isFlashing: false }, timer: 1.6, phase: 0, homeCity: city.id, big: true });
          sound.playBonusAlert();
        }
      }
      if (city.alarm > 0) city.alarm -= dt;
      const near = city.y > this.camY - 160 && city.y < this.camY + this.viewH() + 32;
      if (!near) return;
      const defenders = this.enemies.filter(e => e.homeCity === city.id && !e.isBoss).length +
        this.spawnAnimations.filter(s => s.homeCity === city.id).length;
      // More defenders when players are inside the city, and a call for help when the HQ is hit
      const intruder = this.players.some(p => !p.dead && this.inZone(city, p.x + 13, p.y + 13));
      const wanted = city.garrison + (intruder ? 1 : 0) + (city.alarm > 0 ? 2 : 0);
      city.spawnTimer -= dt;
      if (defenders >= wanted || city.spawnTimer > 0) return;
      city.spawnTimer = city.alarm > 0 ? 1.5 : 3.5;
      // Not behind the bottom of the screen (nobody may be left behind there)
      const free = city.spawns.filter(s => s.y + 26 <= this.camY + this.viewH() &&
        !this.map.isBlocked(s.x, s.y, 26, 26, false, null) && !this.map.isEnclosed(s.x, s.y));
      if (free.length) {
        const s = free[Math.floor(Math.random() * free.length)];
        this.queueConquestEnemy(s.x, s.y, city);
      }
    });
  }

  // Night options in force: the host's while playing online as a guest
  get nightOpts() {
    return (this.isGuest() && this.hostNightOpts) || this.localNightOpts;
  }

  // 0 at noon .. ~0.62 at midnight (conquest only)
  darkness() {
    if (!this.layout.conquest || !this.nightOpts.cycle) return 0;
    return Math.max(0, -Math.cos(((this.dayTime || 0) / DAY_LENGTH) * Math.PI * 2)) * 0.62;
  }

  // Night: a dark layer over the field with holes cut out by headlights, fire and shells
  renderNight() {
    const dark = this.darkness();
    if (dark < 0.02) return;
    const W = this.map.pxW;
    const H = this.viewH();
    const k = 2; // Light map resolution (px per logical px)
    if (!this.nightCanvas) this.nightCanvas = document.createElement('canvas');
    const nc = this.nightCanvas;
    if (nc.width !== W * k || nc.height !== H * k) {
      nc.width = W * k;
      nc.height = H * k;
    }
    const n = nc.getContext('2d');
    n.setTransform(1, 0, 0, 1, 0, 0);
    n.globalCompositeOperation = 'source-over';
    n.clearRect(0, 0, nc.width, nc.height);
    n.fillStyle = `rgba(4, 8, 24, ${dark})`;
    n.fillRect(0, 0, nc.width, nc.height);

    n.globalCompositeOperation = 'destination-out';
    n.setTransform(k, 0, 0, k, 0, -this.camY * k);
    const light = (x, y, r, strength) => {
      const gr = n.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0, 0, 0, ${strength})`);
      gr.addColorStop(1, 'rgba(0, 0, 0, 0)');
      n.fillStyle = gr;
      n.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // Headlight cones in front of every tank, and a little glow around it
    this.players.concat(this.enemies).forEach(t => {
      if (t.dead) return;
      const d = DIRS[t.direction] || DIRS.UP;
      const cx = t.x + 13;
      const cy = t.y + 13;
      if (t.lightsOff) {
        light(t.x + 13, t.y + 13, 12, 0.25); // Lights off: barely visible
        return;
      }
      const reach = t.type === 'player' ? 90 * (1 + 0.35 * ((this.upgrades && this.upgrades.lights) || 0)) : 60;
      const a = Math.atan2(d.dy, d.dx);
      n.save();
      n.beginPath();
      n.moveTo(cx + d.dx * 10, cy + d.dy * 10);
      n.arc(cx, cy, reach, a - 0.42, a + 0.42);
      n.closePath();
      n.clip();
      light(cx + d.dx * 10, cy + d.dy * 10, reach, t.type === 'player' ? 0.95 : 0.7);
      n.restore();
      light(cx, cy, 24, t.type === 'player' ? 0.7 : 0.4);
    });
    this.explosions.forEach(e => light(e.x, e.y, e.large ? 80 : 36, 0.9 * (1 - Math.min(1, e.timer / e.duration))));
    this.lights.forEach(l => light(l.x, l.y, l.radius * 1.4, 0.9 * (1 - l.t / l.duration)));
    this.bullets.forEach(b => light(b.x + 3, b.y + 3, 16, 0.8));
    this.cities.forEach(c => { if (c.alive) light(c.x + 16, c.y + 16, 34, 0.55); });
    this.turrets.forEach(t => { if (t.alive) light(t.x + 12, t.y + 12, 14, 0.5); });
    this.parts.forEach(p => { if (p.settled && p.heat > 0) light(p.x, p.y, 10, 0.6 * Math.min(1, p.heat)); });
    this.nightLightsExtra(light, n);

    this.ctx.drawImage(nc, 0, this.camY, W, H);
  }

  // -------------------------------------------------------------
  // NIGHT RULES (conquest; each one can be switched off in SETTINGS > НОЧЬ)
  // -------------------------------------------------------------
  // A night rule is active: conquest, cycle on, that rule on, and it is dark enough
  nightRule(key) {
    return !!(this.layout.conquest && this.nightOpts.cycle && this.nightOpts[key] && this.darkness() > 0.3);
  }

  // How far enemies notice a player: with headlights on far, with them off only close up
  // (a shot gives the tank away for a moment)
  detectRange(p) {
    if (!this.nightRule('lights')) return Infinity;
    if (p.revealTimer > 0) return 190;
    return p.lightsOff ? 70 : 190;
  }

  // Nearest player this enemy can notice (null: it wanders)
  nearestTarget(tank) {
    let best = null;
    let bestDist = Infinity;
    for (const p of this.players) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - tank.x, p.y - tank.y);
      if (d < bestDist && d <= this.detectRange(p)) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  toggleLights(idx) {
    if (this.isGuest()) {
      this.net.send({ t: 'cmd', c: 'lights' });
      return;
    }
    const p = this.players[idx];
    if (!p || p.dead) return;
    p.lightsOff = !p.lightsOff;
    sound.playRicochet('shield');
    this.floatingScores.push(new FloatingScore(p.x + 13, p.y - 6, 0, {
      text: p.lightsOff ? 'LIGHTS OFF' : 'LIGHTS ON', color: '#fff59d', duration: 1, rise: 12
    }));
  }

  // Sweeping searchlight of a city; the angle follows the synced day time so guests see the same
  searchlightAngle(city) {
    return Math.PI / 2 + Math.sin((this.dayTime || 0) * 0.7 + city.id * 1.7) * 1.1;
  }

  updateNightRules(dt) {
    // Searchlights: a player caught in a beam brings the garrison out
    if (this.nightRule('searchlights')) {
      this.cities.forEach(city => {
        if (!city.alive || city.lampDead) return;
        if (city.spotCooldown > 0) { city.spotCooldown -= dt; return; }
        const cx = city.x + 16;
        const cy = city.y + 16;
        const a = this.searchlightAngle(city);
        const caught = this.players.find(p => {
          if (p.dead) return false;
          const dx = p.x + 13 - cx;
          const dy = p.y + 13 - cy;
          const d = Math.hypot(dx, dy);
          if (d > 150 || d < 10) return false;
          let diff = Math.atan2(dy, dx) - a;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          return Math.abs(diff) < 0.24;
        });
        if (caught) {
          city.alarm = 8;
          city.spotCooldown = 6;
          sound.playBonusAlert();
          this.floatingScores.push(new FloatingScore(caught.x + 13, caught.y - 6, 0, {
            text: 'SPOTTED!', color: '#ff5252', duration: 1.4, rise: 12
          }));
        }
      });
    }

    // Water freezes around midnight and thaws in the morning (never under a tank)
    this.freezeTimer2 = (this.freezeTimer2 || 0) - dt;
    if (this.freezeTimer2 > 0) return;
    this.freezeTimer2 = 0.5;
    const freezeOn = this.layout.conquest && this.nightOpts.cycle && this.nightOpts.ice;
    const dark = this.darkness();
    if (freezeOn && dark > 0.45 && !this.waterFrozen) {
      this.waterFrozen = true;
      this.freezeWater(0, this.map.rows);
      sound.playPowerUpCollect('clock');
    } else if (this.waterFrozen && (dark < 0.25 || !freezeOn)) {
      this.thawWater();
    }
  }

  freezeWater(r0, r1) {
    const T = MapGenerator.TILES;
    for (let r = r0; r < r1; r++) {
      for (let c = 0; c < this.map.cols; c++) {
        if (this.map.grid[r][c] !== T.WATER) continue;
        this.map.grid[r][c] = T.ICE;
        this.map.frozen.add(r * this.map.cols + c);
      }
    }
  }

  thawWater() {
    const T = MapGenerator.TILES;
    const tanks = this.players.concat(this.enemies).filter(t => !t.dead);
    for (const key of Array.from(this.map.frozen)) {
      const r = Math.floor(key / this.map.cols);
      const c = key % this.map.cols;
      const under = tanks.some(t => t.x < c * 16 + 16 && t.x + t.w > c * 16 && t.y < r * 16 + 16 && t.y + t.h > r * 16);
      if (under) continue;
      if (this.map.grid[r] && this.map.grid[r][c] === T.ICE) this.map.grid[r][c] = T.WATER;
      this.map.frozen.delete(key);
    }
    if (this.map.frozen.size === 0) this.waterFrozen = false;
  }

  flareAllowed() {
    return !!(this.layout.conquest && this.nightOpts.cycle && this.nightOpts.bonus);
  }

  // Night bonus: more points for kills and a chance of a bonus from any tank
  nightBonusActive() {
    return this.nightRule('bonus');
  }

  // Night layer extras: searchlight beams and flare light cut holes in the darkness
  nightLightsExtra(light, n) {
    if (this.nightRule('searchlights')) {
      this.cities.forEach(city => {
        if (!city.alive || city.lampDead) return;
        const cx = city.x + 16;
        const cy = city.y + 16;
        const a = this.searchlightAngle(city);
        n.save();
        n.beginPath();
        n.moveTo(cx, cy);
        n.arc(cx, cy, 150, a - 0.24, a + 0.24);
        n.closePath();
        n.clip();
        light(cx, cy, 150, 0.8);
        n.restore();
      });
    }
    this.flares.forEach(f => {
      const p = f.t / f.dur;
      light(f.x, f.y, 170 * (p < 0.1 ? p / 0.1 : 1), 0.95 * (1 - Math.max(0, p - 0.8) / 0.2));
    });
  }

  // Searchlight lamps on the HQs, and their visible beams at night
  renderSearchlights() {
    const ctx = this.ctx;
    const night = this.nightRule('searchlights');
    this.cities.forEach(city => {
      if (!city.alive) return;
      const lx = city.x + 28;
      const ly = city.y + 1;
      if (night && !city.lampDead) {
        const cx = city.x + 16;
        const cy = city.y + 16;
        const a = this.searchlightAngle(city);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 150);
        g.addColorStop(0, 'rgba(255, 250, 210, 0.22)');
        g.addColorStop(1, 'rgba(255, 250, 210, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, 150, a - 0.24, a + 0.24);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // The lamp itself (a target: shooting it switches the searchlight off)
      ctx.fillStyle = '#2a2f37';
      ctx.fillRect(lx - 3, ly - 3, 6, 6);
      ctx.fillStyle = city.lampDead ? '#3a2020' : night ? '#fffde7' : '#8a8f99';
      ctx.beginPath();
      ctx.arc(lx, ly, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Captured cities now and then leave a bonus by their ruined HQ (while on screen)
  updateCapturedCities(dt) {
    this.cities.forEach(city => {
      if (!city.captured) return;
      city.bonusTimer -= dt;
      if (city.bonusTimer > 0) return;
      city.bonusTimer = 30 + Math.random() * 20;
      const z = city.zone;
      if (z.y + z.h < this.camY || z.y > this.camY + this.viewH()) return;
      if (this.powerups.some(p => this.inZone(city, p.x + 14, p.y + 14))) return;
      const T = MapGenerator.TILES;
      const spots = [[-32, 0], [32, 0], [0, 32], [0, -32], [-32, 32], [32, 32]];
      for (const [dx, dy] of spots) {
        const x = city.x + dx;
        const y = city.y + dy;
        const c = Math.floor(x / 16);
        const r = Math.floor(y / 16);
        if (r < 0 || c < 0 || r + 1 >= this.map.rows || c + 1 >= this.map.cols) continue;
        const tiles = [this.map.grid[r][c], this.map.grid[r][c + 1], this.map.grid[r + 1][c], this.map.grid[r + 1][c + 1]];
        if (tiles.some(t => t === T.STEEL || t === T.WATER)) continue;
        const bonuses = ['star', 'helmet', 'clock', 'grenade', 'tank', 'gun', 'boat'].concat(this.flareAllowed() ? ['flare'] : []);
        this.powerups.push(new PowerUpItem(c * 16, r * 16, bonuses[Math.floor(Math.random() * bonuses.length)]));
        this.spawnRing(c * 16 + 14, r * 16 + 14, PLAYER_COLORS[city.owner || 0][0], 26, 0.5);
        sound.playPowerUpSpawn();
        return;
      }
    });
  }

  // Fortress guns: turn to a player in line with them and fire
  updateTurrets(dt) {
    const diff = DIFFICULTY[this.difficulty];
    this.turrets.forEach(t => {
      if (!t.alive) return;
      if (t.flash > 0) t.flash -= dt;
      if (t.y + t.h < this.camY || t.y > this.camY + this.viewH()) return; // Off screen: idle
      t.cooldown -= dt;
      const cx = t.x + 12;
      const cy = t.y + 12;
      let aim = null;
      let best = Infinity;
      this.players.forEach(p => {
        if (p.dead) return;
        const dx = p.x + 13 - cx;
        const dy = p.y + 13 - cy;
        if (Math.hypot(dx, dy) > this.detectRange(p)) return; // Unseen in the dark
        if (Math.abs(dx) < 12 && Math.abs(dy) < best) { best = Math.abs(dy); aim = dy < 0 ? 'UP' : 'DOWN'; }
        else if (Math.abs(dy) < 12 && Math.abs(dx) < best) { best = Math.abs(dx); aim = dx < 0 ? 'LEFT' : 'RIGHT'; }
      });
      if (!aim) return;
      t.dir = aim;
      if (t.cooldown > 0 || t.activeBullets > 0 || this.isFrozen) return;
      t.cooldown = 1.6 * diff.reaction;
      const d = DIRS[aim];
      t.activeBullets++;
      t.flash = 0.08;
      this.addBullet(new Bullet('enemy', cx - 3 + d.dx * 15, cy - 3 + d.dy * 15, aim, 4.2 * diff.bullet, false, t));
    });
  }

  // The wall cell under a destroyed turret becomes brick again (no empty pocket in the wall)
  fillTurretCell(t) {
    const c = Math.floor((t.x - 4) / 16);
    const r = Math.floor((t.y - 4) / 16);
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        if (!this.map.grid[r + dr] || c + dc >= this.map.cols) continue;
        this.map.grid[r + dr][c + dc] = MapGenerator.TILES.BRICK;
        this.map.brickMasks[r + dr][c + dc] = 0x0F;
      }
    }
  }

  hitTurret(t, bullet) {
    if (bullet.owner !== 'player') return;
    t.hp--;
    this.spawnRicochetSparks(bullet.x + 3, bullet.y + 3);
    sound.playRicochet('armor');
    if (t.hp > 0) return;
    t.alive = false;
    this.fillTurretCell(t);
    this.explosions.push(new ExplosionEffect(t.x + 12, t.y + 12, true));
    this.spawnTankDebris(t.x + 12, t.y + 12, ['#5d6674', '#9aa5b4', '#ff7043']);
    this.addScreenShake(4);
    sound.playExplosion(true);
    this.addScore(500, t.x + 12, t.y + 6, bullet.shooter);
  }

  renderTurrets() {
    const ctx = this.ctx;
    const t0 = Date.now() / 1000;
    this.turrets.forEach(t => {
      if (t.y > this.camY + this.viewH() + 30 || t.y + 30 < this.camY) return;
      const cx = t.x + 12;
      const cy = t.y + 12;
      ctx.save();
      if (!t.alive) {
        ctx.fillStyle = '#1e2228';
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      // Octagonal armoured base
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.beginPath();
      ctx.arc(cx + 1.5, cy + 2, 12, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(t.x, t.y, t.x + 24, t.y + 24);
      g.addColorStop(0, '#8c96a4');
      g.addColorStop(1, '#3b424d');
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + k * Math.PI / 4;
        const px = cx + Math.cos(a) * 12;
        const py = cy + Math.sin(a) * 12;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // Rotating gun
      const angle = { UP: 0, RIGHT: Math.PI / 2, DOWN: Math.PI, LEFT: -Math.PI / 2 }[t.dir];
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.fillStyle = '#2a2f37';
      ctx.fillRect(-2.2, -15, 4.4, 12);
      ctx.fillStyle = '#c7cfda';
      ctx.fillRect(-2.2, -15, 1.4, 12);
      if (t.flash > 0) {
        ctx.fillStyle = '#fff59d';
        ctx.beginPath();
        ctx.arc(0, -16, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#4a525e';
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      // Blinking red light
      ctx.fillStyle = Math.floor(t0 * 3 + t.x) % 2 ? '#ff1744' : '#5a0f12';
      ctx.beginPath();
      ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // Player shell hits an enemy headquarters
  hitCity(city, bullet) {
    const cx = city.x + 16;
    const cy = city.y + 16;
    if (bullet.owner !== 'player') {
      this.spawnRicochetSparks(bullet.x + 3, bullet.y + 3); // Their own shells do not hurt it
      return;
    }
    city.hp--;
    city.alarm = 8; // The garrison is called in
    this.explosions.push(new ExplosionEffect(bullet.x + 3, bullet.y + 3, false));
    this.spawnRing(cx, cy, '#ff1744', 22, 0.35);
    this.addScreenShake(2);
    sound.playRicochet('armor');
    if (city.hp <= 0) this.destroyHQ(city, bullet.shooter);
  }

  // One HQ destroyed; a fortress needs all of its HQs gone before it falls
  destroyHQ(city, player) {
    if (!city.group) {
      this.captureCity(city, player);
      return;
    }
    city.alive = false;
    const members = this.cities.filter(c => c.group === city.group);
    const left = members.filter(c => c.alive).length;
    const cx = city.x + 16;
    const cy = city.y + 16;
    this.explosions.push(new ExplosionEffect(cx, cy, true));
    this.spawnTankDebris(cx, cy, ['#e53935', '#ffd54f', '#8d6e63', '#bdbdbd']);
    this.addScreenShake(6);
    sound.playExplosion(true);
    if (left > 0) {
      this.addScore(1000, cx, cy - 10, player);
      this.floatingScores.push(new FloatingScore(cx, cy - 26, 0, {
        text: 'HQ ' + (members.length - left) + '/' + members.length, color: '#ffd54f', duration: 2, rise: 10
      }));
      members.forEach(c => { c.alarm = 10; });
      return;
    }
    // The whole fortress falls: its turrets blow up and every garrison gives up
    this.turrets.forEach(t => {
      if (t.group !== city.group || !t.alive) return;
      t.alive = false;
      this.fillTurretCell(t);
      this.explosions.push(new ExplosionEffect(t.x + 12, t.y + 12, true));
      this.spawnTankDebris(t.x + 12, t.y + 12, ['#5d6674', '#9aa5b4', '#ff7043']);
    });
    members.forEach(c => { c.alive = true; this.captureCity(c, player, c !== city); });
    this.addScore(5000, cx, cy - 20, player);
    this.conquestStatsAdd('fortresses');
  }

  // Headquarters destroyed: the city and its land become the players'
  // quiet: capture without the big effects (other HQs of a fortress)
  captureCity(city, player, quiet = false) {
    const cx = city.x + 16;
    const cy = city.y + 16;
    city.alive = false;
    city.captured = true;
    city.owner = player ? player.index : 0;
    this.lastCaptured = city;
    if (!quiet) {
      this.citiesCaptured++;
      this.explosions.push(new ExplosionEffect(cx, cy, true));
      this.spawnTankDebris(cx, cy, ['#e53935', '#ffd54f', '#8d6e63', '#bdbdbd']);
      this.spawnRing(cx, cy, PLAYER_COLORS[city.owner][0], 60, 0.8);
      this.flashScreen();
      this.addScreenShake(8);
      sound.playExplosion(true);
      sound.playPowerUpCollect('tank');
      this.addScore(2000, cx, cy - 10, player);
      this.floatingScores.push(new FloatingScore(cx, cy - 26, 0, {
        text: city.name + (city.group ? ' HAS FALLEN' : ' TAKEN'), color: PLAYER_COLORS[city.owner][0], duration: 3, rise: 10
      }));
    }
    // The garrison gives up
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].homeCity === city.id) this.destroyEnemy(this.enemies[i], i, player);
    }
    this.spawnAnimations = this.spawnAnimations.filter(s => s.homeCity !== city.id);
    this.updateHUD();
    if (!quiet) {
      // Armour plates refill, then the team picks an upgrade
      this.players.forEach(p => { if (!p.dead) p.armor = this.upgrades.armor || 0; });
      this.offerUpgrade();
    }
  }

  // Respawn on free ground near the bottom middle of the screen
  findRespawnSpot(p) {
    const T = MapGenerator.TILES;
    // Last captured city on screen: respawn among its streets
    const home = this.lastCaptured;
    if (home && home.zone.y + home.zone.h > this.camY + 32 && home.zone.y < this.camY + this.viewH() - 32) {
      for (let k = 0; k < 40; k++) {
        const x = Math.round((home.x - 48 + Math.random() * 96 - 3) / 16) * 16 + 3;
        const y = Math.round((home.y - 48 + Math.random() * 96 - 3) / 16) * 16 + 3;
        if (y < this.camY + 4 || y + 26 > this.camY + this.viewH() - 4) continue;
        if (!this.map.isBlocked(x, y, 26, 26, false, p, true) && !this.map.isEnclosed(x, y)) {
          p.spawnX = x;
          p.spawnY = y;
          return;
        }
      }
    }
    const bottomRow = Math.floor((this.camY + this.viewH()) / 16) - 3;
    const topRow = Math.floor((this.camY + this.viewH() / 2) / 16);
    const mid = Math.floor(this.map.cols / 2) - 1;
    for (let r = bottomRow; r >= topRow; r--) {
      for (let k = 0; k < this.map.cols - 1; k++) {
        const c = mid + (k % 2 ? -1 : 1) * Math.ceil(k / 2);
        if (c < 0 || c > this.map.cols - 2 || r < 0 || r > this.map.rows - 2) continue;
        const tiles = [this.map.grid[r][c], this.map.grid[r][c + 1], this.map.grid[r + 1][c], this.map.grid[r + 1][c + 1]];
        if (tiles.some(t => t === T.BRICK || t === T.STEEL || t === T.WATER)) continue;
        const x = c * 16 + 3;
        const y = r * 16 + 3;
        if (this.players.concat(this.enemies).some(t => t !== p && !t.dead && Math.abs(t.x - x) < 28 && Math.abs(t.y - y) < 28)) continue;
        if (this.map.isEnclosed(x, y)) continue;
        p.spawnX = x;
        p.spawnY = y;
        return;
      }
    }
    // Nowhere free: clear a spot
    const c = mid;
    const r = bottomRow;
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
      this.map.grid[r + dr][c + dc] = T.EMPTY;
      this.map.brickMasks[r + dr][c + dc] = 0;
    }
    p.spawnX = c * 16 + 3;
    p.spawnY = r * 16 + 3;
  }

  // Sidebar minimap: the three screens of land, cities, tanks and the visible window
  renderMinimap() {
    const cv = document.getElementById('minimap');
    if (!cv || !this.layout.conquest || !this.map.grid) return;
    const m = cv.getContext('2d');
    const sx = cv.width / this.map.cols;
    const sy = cv.height / this.map.rows;
    const T = MapGenerator.TILES;
    const colors = { [T.BRICK]: '#9c4a2c', [T.STEEL]: '#9aa5b4', [T.WATER]: '#1e5bb5', [T.TREES]: '#2e7d32', [T.ICE]: '#9fcbe8' };
    m.fillStyle = '#15191f';
    m.fillRect(0, 0, cv.width, cv.height);
    for (let r = 0; r < this.map.rows; r++) {
      for (let c = 0; c < this.map.cols; c++) {
        const color = colors[this.map.grid[r][c]];
        if (!color) continue;
        m.fillStyle = color;
        m.fillRect(c * sx, r * sy, sx, sy);
      }
    }
    this.cities.forEach(city => {
      const z = city.zone;
      if (city.captured) {
        m.fillStyle = PLAYER_COLORS[city.owner || 0][0];
        m.globalAlpha = 0.35;
        m.fillRect(z.x / 16 * sx, z.y / 16 * sy, z.w / 16 * sx, z.h / 16 * sy);
        m.globalAlpha = 1;
      }
      m.fillStyle = city.alive ? '#ff1744' : PLAYER_COLORS[city.owner || 0][0];
      m.fillRect(city.x / 16 * sx - 1, city.y / 16 * sy - 1, 2 * sx + 2, 2 * sy + 2);
    });
    m.fillStyle = '#ff5252';
    this.enemies.forEach(e => { if (!e.dead) m.fillRect((e.x + 9) / 16 * sx, (e.y + 9) / 16 * sy, 2, 2); });
    this.players.forEach(p => {
      if (p.dead) return;
      m.fillStyle = PLAYER_COLORS[p.index][0];
      m.fillRect((p.x + 8) / 16 * sx - 0.5, (p.y + 8) / 16 * sy - 0.5, 3, 3);
    });
    m.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    m.lineWidth = 1;
    m.strokeRect(0.5, this.camY / 16 * sy + 0.5, cv.width - 1, this.viewH() / 16 * sy - 1);
  }

  // Compass at the screen edge pointing to the nearest city still held by the enemy
  renderCompass() {
    if (!this.layout.conquest) return;
    const alive = this.players.filter(p => !p.dead);
    if (!alive.length) return;
    const px = alive.reduce((s, p) => s + p.x + 13, 0) / alive.length;
    const py = alive.reduce((s, p) => s + p.y + 13, 0) / alive.length;
    let target = null;
    let best = Infinity;
    this.cities.forEach(c => {
      if (!c.alive) return;
      const d = Math.hypot(c.x + 16 - px, c.y + 16 - py);
      if (d < best) { best = d; target = c; }
    });
    if (!target) return;
    const sy = target.y + 16 - this.camY;
    if (sy > 0 && sy < this.viewH()) return; // City is on screen
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    const ahead = sy <= 0;
    const x = Math.max(16, Math.min(this.map.pxW - 16, target.x + 16));
    const y = ahead ? 10 + Math.sin(t * 5) * 1.5 : this.viewH() - 10 - Math.sin(t * 5) * 1.5;
    ctx.save();
    ctx.fillStyle = '#ff5252';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ahead) { ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y + 2); ctx.lineTo(x - 5, y + 2); }
    else { ctx.moveTo(x, y + 6); ctx.lineTo(x + 5, y - 2); ctx.lineTo(x - 5, y - 2); }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.font = '6px "Press Start 2P", monospace';
    ctx.textAlign = x < 60 ? 'left' : x > this.map.pxW - 60 ? 'right' : 'center';
    const tx = ctx.textAlign === 'left' ? x - 4 : ctx.textAlign === 'right' ? x + 4 : x;
    const label = target.name + ' ' + Math.round(best / 16);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText(label, tx + 0.6, (ahead ? y + 11 : y - 8) + 0.6);
    ctx.fillStyle = '#ffd0d0';
    ctx.fillText(label, tx, ahead ? y + 11 : y - 8);
    ctx.restore();
  }

  // Captured land: tinted with the owner's colour and outlined
  renderTerritory() {
    const ctx = this.ctx;
    this.cities.forEach(city => {
      if (!city.captured) return;
      const color = PLAYER_COLORS[city.owner || 0][0];
      const z = city.zone;
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = color;
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
      ctx.restore();
    });
  }

  // Enemy headquarters (red Eagle with a health bar), or the players' flag once captured
  renderCities() {
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    this.cities.forEach(city => {
      if (city.y > this.camY + this.viewH() + 40 || city.y + 32 < this.camY - 40) return;
      if (city.alive) {
        // Red warning glow
        const g = ctx.createRadialGradient(city.x + 16, city.y + 14, 2, city.x + 16, city.y + 14, 26);
        g.addColorStop(0, `rgba(255, 40, 40, ${0.18 + Math.sin(t * 3) * 0.08})`);
        g.addColorStop(1, 'rgba(255, 40, 40, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(city.x - 12, city.y - 12, 56, 56);
        ctx.drawImage(Sprites.cache['eagle_enemy'], 0, 0, 64, 64, city.x, city.y, 32, 32);
        if (city.hp <= city.maxHp / 2) this.renderBaseCracks(city);
        // Health bar
        const frac = city.hp / city.maxHp;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(city.x + 2, city.y - 6, 28, 3.5);
        ctx.fillStyle = frac > 0.5 ? '#ff5252' : '#ffab40';
        ctx.fillRect(city.x + 2.5, city.y - 5.5, 27 * frac, 2.5);
        this.renderCityName(city, city.alarm > 0 && Math.floor(t * 6) % 2 ? '#ffffff' : '#ff6b6b', city.y - 10);
      } else {
        ctx.drawImage(Sprites.cache['eagle_dead'], 0, 0, 64, 64, city.x, city.y, 32, 32);
        this.renderCityName(city, PLAYER_COLORS[city.owner || 0][0], city.y + 42);
      }
    });
  }

  renderCityName(city, color, y) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '6px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText(city.name, city.x + 16.6, y + 0.6);
    ctx.fillStyle = color;
    ctx.fillText(city.name, city.x + 16, y);
    ctx.restore();
  }

  renderCityFlags() {
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    this.cities.forEach(city => {
      if (!city.captured) return;
      const color = PLAYER_COLORS[city.owner || 0][0];
      const px = city.x + 16;
      const py = city.y + 4;
      ctx.save();
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py + 20);
      ctx.lineTo(px, py - 8);
      ctx.stroke();
      // Waving cloth
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(px, py - 8);
      for (let k = 0; k <= 6; k++) {
        const x = px + k * 2;
        ctx.lineTo(x, py - 8 + Math.sin(t * 6 - k * 0.8) * 0.9);
      }
      for (let k = 6; k >= 0; k--) {
        const x = px + k * 2;
        ctx.lineTo(x, py - 1 + Math.sin(t * 6 - k * 0.8) * 0.9);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  // -------------------------------------------------------------
  // CONQUEST ENEMIES WITH SPECIAL TRICKS: artillery shells, mines, scouts' calls
  // -------------------------------------------------------------
  updateSpecialEnemies(dt) {
    this.enemies.forEach(e => {
      if (e.dead || this.isFrozen || e.stunTimer > 0) return;
      const target = this.nearestTarget(e);
      if (!target) return;
      const dist = Math.hypot(target.x - e.x, target.y - e.y);
      const onScreen = e.y + 26 > this.camY;

      if (e.type === 'artillery') {
        if (e.artTimer === undefined) e.artTimer = 2 + Math.random() * 2;
        e.artTimer -= dt;
        if (e.artTimer <= 0 && dist < 230 && onScreen) {
          e.artTimer = (4 + Math.random() * 1.5) * (e.reaction || 1);
          // Aims a little ahead of a moving tank
          const lead = target.moving ? 20 : 0;
          const d = DIRS[target.direction] || DIRS.UP;
          this.shells.push({
            fx: e.x + 13, fy: e.y + 13,
            // At night (night enemies rule) the gunners can barely see: much wider spread
            tx: target.x + 13 + d.dx * lead + (Math.random() - 0.5) * 16 * (this.nightRule('enemies') ? 3 : 1),
            ty: target.y + 13 + d.dy * lead + (Math.random() - 0.5) * 16 * (this.nightRule('enemies') ? 3 : 1),
            t: 0, dur: 1.3
          });
          e.recoil = 2.5;
          sound.playMortar();
        }
      } else if (e.type === 'miner') {
        if (e.mineTimer === undefined) e.mineTimer = 2.5;
        e.mineTimer -= dt;
        if (e.mineTimer <= 0 && e.moving && onScreen) {
          e.mineTimer = 4 + Math.random() * 3;
          const d = DIRS[e.direction] || DIRS.UP;
          if (this.mines.length < 14) this.mines.push({ x: e.x + 13 - d.dx * 16, y: e.y + 13 - d.dy * 16, arm: 1.0, life: 45 });
        }
      } else if (e.type === 'scout') {
        if (!e.called && dist < 170 && onScreen) {
          e.called = true;
          e.callTimer = 1.5;
          this.spawnRing(e.x + 13, e.y + 13, '#ffeb3b', 44, 0.8);
          this.addLight(e.x + 13, e.y + 13, 60, 0.6, '255, 235, 120');
          this.floatingScores.push(new FloatingScore(e.x + 13, e.y - 4, 0, {
            text: 'BACKUP!', color: '#ffeb3b', duration: 1.6, rise: 14
          }));
          sound.playBonusAlert();
        }
        if (e.callTimer > 0) {
          e.callTimer -= dt;
          if (e.callTimer <= 0) this.extraSpawns = (this.extraSpawns || 0) + 2; // Two tanks arrive at once
        }
      }

      // Boss crushes brick walls it drives into
      if (e.isBoss && e.moving) this.crushBricks(e);
    });

    // Artillery shells land after their flight
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t += dt;
      if (s.t < s.dur) continue;
      this.shells.splice(i, 1);
      this.artilleryImpact(s.tx, s.ty);
    }

    // Mines arm after a second and go off under a player's tank
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.arm -= dt;
      m.life -= dt;
      if (m.life <= 0) {
        this.mines.splice(i, 1);
        continue;
      }
      if (m.arm > 0) continue;
      const victim = this.players.find(p => !p.dead && Math.abs(p.x + 13 - m.x) < 14 && Math.abs(p.y + 13 - m.y) < 14);
      if (victim) {
        this.mines.splice(i, 1);
        this.explodeMine(m);
        if (victim.shieldTimer <= 0) this.killPlayer(victim);
      }
    }
  }

  artilleryImpact(x, y) {
    this.explosions.push(new ExplosionEffect(x, y, true));
    this.addScreenShake(3);
    sound.playExplosion(false);
    this.addScorch(x, y, 12);
    // Blast: players close by (unless shielded) and brick around the point
    this.players.forEach(p => {
      if (!p.dead && p.shieldTimer <= 0 && Math.abs(p.x + 13 - x) < 20 && Math.abs(p.y + 13 - y) < 20) this.killPlayer(p);
    });
    const c0 = Math.floor((x - 12) / 16);
    const c1 = Math.floor((x + 12) / 16);
    const r0 = Math.floor((y - 12) / 16);
    const r1 = Math.floor((y + 12) / 16);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r < 0 || c < 0 || r >= this.map.rows || c >= this.map.cols) continue;
        if (this.map.grid[r][c] === MapGenerator.TILES.BRICK) {
          this.map.grid[r][c] = MapGenerator.TILES.EMPTY;
          this.map.brickMasks[r][c] = 0;
          this.spawnBrickDebris(c * 16 + 8, r * 16 + 8);
        }
      }
    }
  }

  explodeMine(m) {
    this.explosions.push(new ExplosionEffect(m.x, m.y, true));
    this.addScreenShake(3);
    sound.playExplosion(false);
    this.addScorch(m.x, m.y, 10);
  }

  // Free 52x52 place for the boss near the middle of its fortress (brick does not count: it crushes it)
  findBossSpot(z) {
    const cx = z.x + z.w / 2 - 26;
    const cy = z.y + z.h / 2 - 26;
    for (let ring = 0; ring <= 6; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = Math.round((cx + dx * 16 - 3) / 16) * 16 + 3;
          const y = Math.round((cy + dy * 16 - 3) / 16) * 16 + 3;
          if (x < 0 || y < 0 || x + 52 > this.map.pxW || y + 52 > this.map.pxH) continue;
          if (!this.map.isBlocked(x, y, 52, 52, false, BOSS_PROBE, true)) return { x, y };
        }
      }
    }
    return null;
  }

  // Boss drives through brick: tiles under it crumble
  crushBricks(t) {
    const c0 = Math.max(0, Math.floor(t.x / 16));
    const c1 = Math.min(this.map.cols - 1, Math.floor((t.x + t.w - 1) / 16));
    const r0 = Math.max(0, Math.floor(t.y / 16));
    const r1 = Math.min(this.map.rows - 1, Math.floor((t.y + t.h - 1) / 16));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (this.map.grid[r][c] !== MapGenerator.TILES.BRICK) continue;
        this.map.grid[r][c] = MapGenerator.TILES.EMPTY;
        this.map.brickMasks[r][c] = 0;
        this.spawnBrickDebris(c * 16 + 8, r * 16 + 8);
        sound.playHitBrick();
      }
    }
  }

  // Shell in flight (with its shadow and a warning mark where it will land), and mines
  renderShellsAndMines() {
    const ctx = this.ctx;
    const t = Date.now() / 1000;
    this.mines.forEach(m => {
      ctx.save();
      ctx.fillStyle = '#20242a';
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#5d6674';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      if (m.arm <= 0) {
        ctx.fillStyle = Math.floor(t * 4) % 2 ? '#ff1744' : '#6a0a12';
        ctx.beginPath();
        ctx.arc(m.x, m.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    this.shells.forEach(s => {
      const p = Math.min(1, s.t / s.dur);
      const x = s.fx + (s.tx - s.fx) * p;
      const gy = s.fy + (s.ty - s.fy) * p;
      const h = Math.sin(p * Math.PI) * 46;
      ctx.save();
      // Warning mark
      ctx.strokeStyle = `rgba(255, 60, 60, ${0.4 + p * 0.5})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(s.tx, s.ty, 18 - p * 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Shadow on the ground, shell above it
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(x, gy, 3, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffcc80';
      ctx.shadowColor = '#ff9100';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, gy - h, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // Health bar over the fortress boss
  renderBossBars() {
    const ctx = this.ctx;
    this.enemies.forEach(e => {
      if (!e.isBoss || e.dead) return;
      const frac = Math.max(0, e.hp / (e.maxHp || e.hp || 1));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(e.x, e.y - 8, e.w, 4);
      ctx.fillStyle = frac > 0.5 ? '#ff5252' : frac > 0.25 ? '#ffab40' : '#ffeb3b';
      ctx.fillRect(e.x + 0.5, e.y - 7.5, (e.w - 1) * frac, 3);
      ctx.font = '6px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff8a80';
      ctx.fillText('BOSS', e.x + e.w / 2, e.y - 11);
    });
  }

  // -------------------------------------------------------------
  // UPGRADES: after every captured city the team picks one of three
  // -------------------------------------------------------------
  offerUpgrade() {
    const options = UPGRADES.filter(u => (this.upgrades[u.id] || 0) < u.max);
    const choices = [];
    while (choices.length < 3 && options.length) {
      choices.push(options.splice(Math.floor(Math.random() * options.length), 1)[0].id);
    }
    if (!choices.length) return;
    this.upgradeChoices = choices;
    this.upgradeIndex = 0;
    this.stateBeforeUpgrade = this.state;
    this.state = 'UPGRADE';
    sound.stopEngineHum();
    this.netUi('upgrade', { choices });
  }

  pickUpgrade(i) {
    if (this.state !== 'UPGRADE' || !this.upgradeChoices) return;
    if (this.isGuest()) {
      this.net.send({ t: 'cmd', c: 'pick', i });
      return;
    }
    const id = this.upgradeChoices[Math.max(0, Math.min(this.upgradeChoices.length - 1, i | 0))];
    this.upgrades[id] = (this.upgrades[id] || 0) + 1;
    if (id === 'life') this.players.forEach(p => { p.lives++; });
    this.players.forEach(p => {
      if (p.dead) return;
      p.upgradeTier(p.tier);            // Re-applies speed and gun upgrades
      p.armor = this.upgrades.armor || 0; // Plates refilled
      if (this.upgrades.boat) p.hasBoat = true;
      this.spawnRing(p.x + 13, p.y + 13, '#80deea', 30, 0.5);
    });
    sound.playPowerUpCollect('star');
    this.upgradeChoices = null;
    this.state = this.stateBeforeUpgrade === 'PAUSED' ? 'PLAYING' : (this.stateBeforeUpgrade || 'PLAYING');
    this.updateHUD();
  }

  // Applied by PlayerTank.upgradeTier (via upgradeHook) on top of the weapon tier
  applyRespawnUpgrades(p) {
    const u = this.upgrades || {};
    p.armor = u.armor || 0;
    if (u.shield) p.shieldTimer += 3 * u.shield;
    if (u.boat) p.hasBoat = true;
  }

  applyUpgrades(p) {
    const u = this.upgrades || {};
    if (u.speed) p.speed *= 1 + 0.1 * u.speed;
    if (u.reload) {
      p.maxBullets += u.reload;
      p.bulletSpeed *= 1 + 0.05 * u.reload;
    }
  }

  // Upgrade cards over the field (also shown on online guests)
  syncUpgradePanel() {
    const panel = document.getElementById('upgrade-panel');
    const show = this.state === 'UPGRADE' && this.upgradeChoices;
    panel.classList.toggle('hidden', !show);
    if (!show) {
      this.upgradePanelKey = null;
      return;
    }
    const key = this.upgradeChoices.join(',') + '|' + this.upgradeIndex;
    if (key === this.upgradePanelKey) return;
    this.upgradePanelKey = key;
    const list = document.getElementById('upgrade-cards');
    list.innerHTML = '';
    this.upgradeChoices.forEach((id, i) => {
      const u = UPGRADES.find(x => x.id === id);
      const card = document.createElement('button');
      card.className = 'upgrade-card' + (i === this.upgradeIndex ? ' selected' : '');
      const level = (this.upgrades[id] || 0) + 1;
      card.innerHTML = '<span class="uc-key">' + (i + 1) + '</span><span class="uc-icon">' + u.icon + '</span>' +
        '<span class="uc-name"></span><span class="uc-desc"></span>';
      card.querySelector('.uc-name').textContent = u.label + (u.max > 1 && u.max < 99 ? ' ' + level : '');
      card.querySelector('.uc-desc').textContent = u.desc;
      card.addEventListener('mouseenter', () => { this.upgradeIndex = i; });
      card.addEventListener('click', () => { card.blur(); this.pickUpgrade(i); });
      list.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // CONQUEST RESULTS
  // -------------------------------------------------------------
  conquestStatsAdd(key) {
    if (!this.cstats) return;
    this.cstats[key] = (this.cstats[key] || 0) + 1;
  }

  renderConquestStats() {
    const el = document.getElementById('conquest-stats');
    const s = this.cstats || {};
    const kills = {};
    this.players.forEach(p => Object.entries(p.kills || {}).forEach(([t, n]) => { kills[t] = (kills[t] || 0) + n; }));
    const total = Object.values(kills).reduce((a, b) => a + b, 0);
    const names = { basic: 'BASIC', fast: 'FAST', power: 'POWER', armor: 'ARMOR', artillery: 'ARTILLERY', miner: 'MINERS', scout: 'SCOUTS', boss: 'BOSSES' };
    const best = loadJSON('tank2026_best_path', 0);
    const isRecord = this.distanceRows > best;
    if (isRecord && !this.isGuest()) saveJSON('tank2026_best_path', this.distanceRows);
    const secs = Math.floor(s.time || 0);
    const rows = [
      ['DISTANCE', this.distanceRows + (isRecord ? '  NEW RECORD!' : '  (BEST ' + best + ')')],
      ['CITIES', String(this.citiesCaptured)],
      ['FORTRESSES', String(s.fortresses || 0)],
      ['BOSSES', String(s.bosses || 0)],
      ['ENEMIES', total + '  ' + Object.entries(kills).filter(([, n]) => n > 0).map(([t, n]) => (names[t] || t) + ' ' + n).join(' · ')],
      ['TIME', Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')]
    ];
    el.innerHTML = '';
    rows.forEach(([k, v], i) => {
      const row = document.createElement('div');
      row.className = 'cs-row' + (i === 0 && isRecord ? ' record' : '');
      row.style.animationDelay = (i * 0.12) + 's';
      const a = document.createElement('span');
      a.className = 'cs-key';
      a.textContent = k;
      const b = document.createElement('span');
      b.className = 'cs-val';
      b.textContent = v;
      row.appendChild(a);
      row.appendChild(b);
      el.appendChild(row);
    });
  }

  recordTreadMark(tank) {
    this.treadMarks.push({
      x: tank.x + 14,
      y: tank.y + 14,
      dir: tank.direction,
      life: 8.0,
      maxLife: 8.0
    });
    if (this.treadMarks.length > 120) {
      this.treadMarks.shift();
    }
  }

  // Conquest: every chunk of land has its own ground, city streets are paved
  renderConquestGround(top, bottom) {
    const ctx = this.ctx;
    const groundFor = {
      FOREST_AMBUSH: 'grass', RIVER_CROSSING: 'grass', VILLAGE: 'grass', CANYON: 'sand',
      WINTER_ICE: 'snow', URBAN_LABYRINTH: 'cobble', RUINS: 'cobble', STEEL_BUNKERS: 'cobble',
      DEFENSE_LINE: 'dirt', SYMMETRICAL_FORTRESS: 'dirt'
    };
    if (!this.groundPatterns) {
      this.groundPatterns = {};
      ['grass', 'sand', 'snow', 'cobble', 'dirt'].forEach(kind => {
        const p = ctx.createPattern(Sprites.cache['ground_' + kind], 'repeat');
        if (p.setTransform) p.setTransform(new DOMMatrix().scale(16 / Sprites.TEX));
        this.groundPatterns[kind] = p;
      });
    }
    const chunkH = MapGenerator.ROWS * 16;
    const W = this.map.pxW;
    (this.map.chunkArchetypes || []).forEach((arch, i) => {
      const y0 = Math.max(top, i * chunkH);
      const y1 = Math.min(bottom, (i + 1) * chunkH);
      if (y1 <= y0) return;
      ctx.fillStyle = this.groundPatterns[groundFor[arch] || 'dirt'];
      ctx.fillRect(0, y0, W, y1 - y0);
      // Soft seam where two lands meet
      if (i > 0 && y0 === i * chunkH) {
        const g = ctx.createLinearGradient(0, y0 - 6, 0, y0 + 6);
        g.addColorStop(0, 'rgba(0, 0, 0, 0)');
        g.addColorStop(0.5, 'rgba(0, 0, 0, 0.35)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y0 - 6, W, 12);
      }
    });
    // Paved city streets
    ctx.fillStyle = this.groundPatterns.cobble;
    this.cities.forEach(c => {
      const z = c.zone;
      if (z.y + z.h < top || z.y > bottom) return;
      ctx.fillRect(z.x, z.y, z.w, z.h);
    });
  }

  renderGround() {
    // High-tech dark tactical bunker battlefield floor
    this.ctx.fillStyle = '#0f1319';
    const W = this.map.pxW;
    const H = this.map.pxH;
    const top = Math.max(0, Math.floor(this.camY / 32) * 32 - 32);
    const bottom = Math.min(H, this.camY + this.viewH() + 32);
    this.ctx.fillRect(0, top, W, bottom - top);
    if (this.layout.conquest) {
      this.renderConquestGround(top, bottom);
      return;
    }

    // Subtle 32px metal plate grid seams
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    this.ctx.lineWidth = 1;
    for (let p = 0; p <= W; p += 32) {
      this.ctx.beginPath();
      this.ctx.moveTo(p, top);
      this.ctx.lineTo(p, bottom);
      this.ctx.stroke();
    }
    for (let p = top; p <= bottom; p += 32) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, p);
      this.ctx.lineTo(W, p);
      this.ctx.stroke();
    }

    // Corner rivet markers on floor plates
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    for (let py = Math.max(32, top - top % 64 + 32); py < bottom; py += 64) {
      for (let px = 32; px < W; px += 64) {
        this.ctx.fillRect(px - 1, py - 1, 2, 2);
      }
    }
  }

  renderTreadMarks() {
    if (this.treadMarks.length === 0) return;
    this.ctx.save();
    this.treadMarks.forEach(tm => {
      const alpha = (tm.life / tm.maxLife) * 0.35;
      this.ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      this.ctx.save();
      this.ctx.translate(tm.x, tm.y);
      if (tm.dir === 'RIGHT') this.ctx.rotate(Math.PI / 2);
      else if (tm.dir === 'DOWN') this.ctx.rotate(Math.PI);
      else if (tm.dir === 'LEFT') this.ctx.rotate(-Math.PI / 2);

      // Two parallel tread track marks
      this.ctx.fillRect(-11, -4, 4, 8);
      this.ctx.fillRect(7, -4, 4, 8);
      this.ctx.restore();
    });
    this.ctx.restore();
  }

  renderParticles() {
    this.ctx.save();
    this.particles.forEach(p => {
      const alpha = Math.max(0, p.life / p.maxLife);
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = p.color;
      if (p.isSmoke) {
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        this.ctx.fill();
      } else if (p.isRipple) {
        // Wake ring, stretched across the direction of travel
        this.ctx.strokeStyle = p.color;
        this.ctx.lineWidth = 0.8;
        this.ctx.beginPath();
        this.ctx.ellipse(p.x, p.y, p.axisX ? p.size * 0.6 : p.size, p.axisX ? p.size : p.size * 0.6, 0, 0, Math.PI * 2);
        this.ctx.stroke();
      } else if (p.isLeaf) {
        this.drawLeaf(this.ctx, p.x, p.y, p.size, p.rot, p.color, 1);
      } else if (p.isSparkle) {
        // Four-point twinkle
        const s = p.size * (0.6 + alpha * 0.8);
        this.ctx.fillRect(p.x - s, p.y - 0.5, s * 2, 1);
        this.ctx.fillRect(p.x - 0.5, p.y - s, 1, s * 2);
      } else {
        this.ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    });
    this.ctx.restore();
  }

  renderRings() {
    if (this.rings.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    this.rings.forEach(r => {
      const p = r.t / r.dur;
      const ease = 1 - Math.pow(1 - p, 3);
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.strokeStyle = r.color;
      ctx.shadowColor = r.color;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 0.5 + 2.5 * (1 - p);
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.1, r.maxR * ease), 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  // Tanks hidden in the forest show through the canopy as a faint ghost
  renderTanksUnderTrees(ctx) {
    const grid = this.map.grid;
    const underTrees = (t) => {
      const c0 = Math.max(0, Math.floor(t.x / 16));
      const c1 = Math.min(this.map.cols - 1, Math.floor((t.x + t.w - 1) / 16));
      const r0 = Math.max(0, Math.floor(t.y / 16));
      const r1 = Math.min(this.map.rows - 1, Math.floor((t.y + t.h - 1) / 16));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (grid[r][c] === MapGenerator.TILES.TREES) return true;
        }
      }
      return false;
    };

    ctx.save();
    ctx.globalAlpha = 0.18;
    this.enemies.concat(this.players).forEach(t => {
      if (!t.dead && underTrees(t)) t.render(ctx);
    });
    ctx.restore();
  }

  // Small circle with the player's initial in the middle of each tank (two-player games)
  renderPlayerBadges(ctx) {
    if (this.players.length < 2) return;
    const names = this.online ? this.playerNames : null;
    ctx.save();
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.players.forEach((p, i) => {
      if (p.dead) return;
      const name = names && names[i];
      const initial = name ? name[0] : String(i + 1);
      const colors = PLAYER_COLORS[p.index];
      // Centre of the hull: the barrel always points away from it, so the badge never covers it
      const cx = p.x + 13;
      const cy = p.y + 13;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.arc(cx + 0.5, cy + 0.7, 5.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors[2];
      ctx.strokeStyle = colors[1];
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(initial, cx + 0.3, cy + 0.4);
    });
    ctx.restore();
  }

  // Conquest armour plates left: small cyan pips over the tank
  renderArmorPips(ctx) {
    this.players.forEach(p => {
      if (p.dead || !p.armor) return;
      for (let k = 0; k < p.armor; k++) {
        ctx.fillStyle = '#80deea';
        ctx.fillRect(p.x + 13 - p.armor * 2.5 + k * 5, p.y - 5, 3.5, 2.5);
      }
    });
  }

  renderBulletTrails() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5;
    this.bullets.forEach(b => {
      const d = DIRS[b.direction];
      const cx = b.x + 3;
      const cy = b.y + 3;
      const len = 6 + b.speed * 3;
      const ex = cx - d.dx * len;
      const ey = cy - d.dy * len;
      const rgb = b.owner === 'player' ? '255, 214, 90' : '255, 120, 80';
      const grad = ctx.createLinearGradient(cx, cy, ex, ey);
      grad.addColorStop(0, `rgba(${rgb}, 0.6)`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    });
    ctx.restore();
  }

  // Icy shimmer over enemies frozen by the Clock bonus
  renderFrost(enemy, time) {
    const ctx = this.ctx;
    const cx = enemy.x + 13;
    const cy = enemy.y + 13;
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 3, cx, cy, 17);
    grad.addColorStop(0, 'rgba(180, 235, 255, 0.05)');
    grad.addColorStop(1, `rgba(155, 231, 255, ${0.35 + Math.sin(time * 5 + enemy.x) * 0.1})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 17, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const a = time * 1.5 + i * (Math.PI * 2 / 3);
      const fx = cx + Math.cos(a) * 12;
      const fy = cy + Math.sin(a) * 12;
      ctx.beginPath();
      ctx.moveTo(fx - 2, fy);
      ctx.lineTo(fx + 2, fy);
      ctx.moveTo(fx, fy - 2);
      ctx.lineTo(fx, fy + 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // RENDER PIPELINE
  // -------------------------------------------------------------
  render() {
    const ctx = this.ctx;
    const time = Date.now() / 1000;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    // Map logical field coordinates onto the high-resolution buffer
    ctx.scale(this.renderScale, this.renderScale);

    // Dynamic Camera Screen Shake
    if (this.screenShake > 0.1) {
      const sx = (Math.random() - 0.5) * this.screenShake;
      const sy = (Math.random() - 0.5) * this.screenShake;
      ctx.translate(sx, sy);
    }
    // Conquest camera: world px -> screen
    ctx.translate(0, -Math.round(this.camY * this.renderScale) / this.renderScale);

    // 0. High-Tech Tactical Bunker Battlefield Ground
    this.renderGround();

    // 0.5. Tank Tread Skidmarks and battle scars
    this.renderTreadMarks();
    this.renderDecals();
    this.renderParts();

    // 1. Lower Terrain Layer (Bricks, Steel, Water, Ice)
    this.map.render(ctx, false, this.waterFrame);
    this.renderTerritory();
    this.renderCities();
    this.renderSearchlights();
    this.renderTurrets();
    if (this.mines.length || this.shells.length) this.renderShellsAndMines();

    // 2. Base Phoenix Eagle Monument (64x64 HD texture rendered at 32x32)
    this.bases.forEach(base => {
      if (base.alive) this.renderEagleGlow(base);
      const eagleSprite = base.alive ? Sprites.cache['eagle_alive'] : Sprites.cache['eagle_dead'];
      ctx.drawImage(eagleSprite, 0, 0, 64, 64, base.x, base.y, 32, 32);
      if (base.alive) this.renderEagleShine(base);
      if (base.alive && base.hp < 2) this.renderBaseCracks(base);
    });

    // 3. Power-ups
    this.powerups.forEach(p => p.render(ctx));

    // 4. Enemy Tanks
    this.enemies.forEach(e => {
      e.render(ctx);
      if (this.isFrozen) this.renderFrost(e, time);
    });

    // 5. Player Tanks
    this.players.forEach(p => p.render(ctx));

    // 6. Bullets
    this.renderBulletTrails();
    this.bullets.forEach(b => b.render(ctx));

    // 7. Upper Terrain Layer (Trees / Foliage Canopy)
    this.map.render(ctx, true);
    this.renderTanksUnderTrees(ctx);

    // 8. Enemy Spawn Animations (Flashing Star with Neon Glow)
    this.spawnAnimations.forEach(sa => {
      sa.phase += 0.2;
      const radius = 12 + Math.sin(sa.phase * 4) * 4;
      ctx.save();
      ctx.translate(sa.x + 14, sa.y + 14);

      const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, radius + 6);
      glow.addColorStop(0, 'rgba(255, 240, 180, 0.45)');
      glow.addColorStop(1, 'rgba(255, 215, 0, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = (Math.floor(sa.phase * 2) % 2 === 0) ? '#ffffff' : '#ffd700';
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let s = 0; s < 4; s++) {
        const a = sa.phase + s * (Math.PI / 2);
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      }
      ctx.stroke();
      ctx.restore();
    });

    // 9. Shockwave rings, combat particles, explosions
    this.renderRings();
    this.renderParticles();
    this.renderNight();
    this.explosions.forEach(e => e.render(ctx));
    this.renderLights();
    this.renderPlayerBadges(ctx);
    this.renderArmorPips(ctx);
    this.renderCityFlags();
    this.renderBossBars();

    // 10. Floating Scores
    this.floatingScores.forEach(fs => fs.render(ctx));

    // Screen-space overlays from here on
    ctx.translate(0, Math.round(this.camY * this.renderScale) / this.renderScale);
    this.renderWeather();
    this.renderCompass();

    // 11. GAME OVER rising from the bottom (classic NES)
    if (this.gameOverText) {
      ctx.save();
      ctx.font = '22px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e52521';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      ctx.fillText('GAME', this.map.pxW / 2, this.gameOverText.y);
      ctx.fillText('OVER', this.map.pxW / 2, this.gameOverText.y + 30);
      ctx.restore();
    }

    ctx.restore();
  }

  loop(timestamp) {
    try {
      if (!this.lastTime) this.lastTime = timestamp;
      let frameTime = (timestamp - this.lastTime) / 1000;
      this.lastTime = timestamp;
      if (frameTime > 0.1) frameTime = 0.1; // clamp lag spikes

      this.pollGamepads();
      this.accumulator = (this.accumulator || 0) + frameTime;
      const FIXED_STEP = 1 / 60; // Exact 60 FPS physics standard

      let steps = 0;
      while (this.accumulator >= FIXED_STEP && steps < 4) {
        this.update(FIXED_STEP);
        this.accumulator -= FIXED_STEP;
        steps++;
      }
      this.render();
      this.syncPauseMenu();
      this.syncUpgradePanel();
      this.minimapTick = ((this.minimapTick || 0) + 1) % 6;
      if (this.minimapTick === 0) this.renderMinimap();

      if (this.online && this.net && this.net.isHost) {
        this.net.sendFrame(this.buildSnapshot(), this.encodeMap());
      }
    } catch (err) {
      console.error("Game loop error:", err);
    }

    requestAnimationFrame(t => this.loop(t));
  }
}

// Instantiate and start
let game = null;
window.addEventListener('DOMContentLoaded', () => {
  game = new Game();
  requestAnimationFrame(t => game.loop(t));
  // ?selftest in the address runs the self-test bot (js/selftest.js)
  if (/selftest/.test(location.search)) {
    const s = document.createElement('script');
    s.src = 'js/selftest.js';
    document.body.appendChild(s);
  }
});
