/**
 * TANK 2026 - Procedural Random Level Generator
 * Strictly adheres to 13x13 Macro-Block (32x32 px) Architecture:
 * - 13x13 macro-blocks = 26x26 tiles (each macro-block is 2x2 tiles of 16x16 px)
 * - Every corridor is at least 32px wide, allowing 26px-28px tanks to move and turn freely!
 * - Guaranteed clear exit corridors above Player and below all 3 Enemy spawns
 * - 6 balanced tactical archetypes (Fortress, River Crossing, Labyrinth, Ice, Forest, Bunkers)
 * - 13x13 BFS Flood Fill path connectivity verification
 */

const MapGenerator = {
  COLS: 26,
  ROWS: 26,
  MACRO_COLS: 13,
  MACRO_ROWS: 13,

  TILES: {
    EMPTY: 0,
    BRICK: 1,
    STEEL: 2,
    WATER: 3,
    TREES: 4,
    ICE: 5
  },

  // Base and Spawn macro coordinates (0..12)
  MACRO_BASE: { mx: 6, my: 12 },
  MACRO_PLAYER1: { mx: 4, my: 12 },
  MACRO_PLAYER2: { mx: 8, my: 12 },

  MACRO_ENEMY_SPAWNS: [
    { mx: 0, my: 0 },   // Top-Left
    { mx: 6, my: 0 },   // Top-Center
    { mx: 12, my: 0 }   // Top-Right
  ],

  BASE_TILES: [
    { x: 12, y: 24 }, { x: 13, y: 24 },
    { x: 12, y: 25 }, { x: 13, y: 25 }
  ],

  BASE_FORT_WALLS: [
    // Left outer & inner
    { x: 11, y: 23 }, { x: 11, y: 24 }, { x: 11, y: 25 },
    { x: 10, y: 23 }, { x: 10, y: 24 }, { x: 10, y: 25 },
    // Top layers (rows 22 and 23)
    { x: 11, y: 22 }, { x: 12, y: 22 }, { x: 13, y: 22 }, { x: 14, y: 22 },
    { x: 12, y: 23 }, { x: 13, y: 23 },
    // Right outer & inner
    { x: 14, y: 23 }, { x: 14, y: 24 }, { x: 14, y: 25 },
    { x: 15, y: 23 }, { x: 15, y: 24 }, { x: 15, y: 25 }
  ],

  PLAYER_SPAWN: { x: 8, y: 24, w: 2, h: 2 },
  PLAYER2_SPAWN: { x: 16, y: 24, w: 2, h: 2 },

  ENEMY_SPAWNS: [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 12, y: 0, w: 2, h: 2 },
    { x: 24, y: 0, w: 2, h: 2 }
  ],

  // Battlefield layouts (tile coordinates). 'big' is two classic fields side by side,
  // one Eagle per half, for up to four online players.
  LAYOUTS: {
    classic: {
      cols: 26, rows: 26,
      bases: [{ x: 12, y: 24 }],
      playerSpawns: [{ x: 8, y: 24 }, { x: 16, y: 24 }],
      enemySpawns: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 24, y: 0 }],
      maxOnScreen: 4,
      totalEnemies: 20
    },
    big: {
      cols: 52, rows: 26,
      bases: [{ x: 12, y: 24 }, { x: 38, y: 24 }],
      playerSpawns: [{ x: 8, y: 24 }, { x: 16, y: 24 }, { x: 34, y: 24 }, { x: 42, y: 24 }],
      enemySpawns: [{ x: 0, y: 0 }, { x: 26, y: 0 }, { x: 12, y: 0 }, { x: 38, y: 0 }, { x: 24, y: 0 }, { x: 50, y: 0 }],
      maxOnScreen: 6,
      totalEnemies: 30
    },
    // Endless conquest: a world three screens tall that keeps growing upwards
    // (see GameMap.loadConquest / pushChunkOnTop); the screen shows viewRows of it
    conquest: {
      cols: 26, rows: 78, viewRows: 26,
      bases: [],
      playerSpawns: [{ x: 8, y: 74 }, { x: 16, y: 74 }, { x: 3, y: 74 }, { x: 21, y: 74 }],
      enemySpawns: [],
      maxOnScreen: 4,
      totalEnemies: 0,
      conquest: true
    }
  },

  // Bunker walls around an Eagle whose top-left tile is (baseX, baseY)
  fortWallsFor(baseX, baseY) {
    return this.BASE_FORT_WALLS.map(pt => ({ x: pt.x + baseX - 12, y: pt.y + baseY - 24 }));
  },

  ARCHETYPES: [
    'SYMMETRICAL_FORTRESS',
    'RIVER_CROSSING',
    'URBAN_LABYRINTH',
    'WINTER_ICE',
    'FOREST_AMBUSH',
    'STEEL_BUNKERS'
  ],

  createRNG(seed) {
    let s = seed >>> 0;
    return function() {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  },

  createEmptyGrid() {
    const grid = [];
    for (let y = 0; y < this.ROWS; y++) {
      grid[y] = new Uint8Array(this.COLS);
    }
    return grid;
  },

  generate(stage = 1, customSeed = null, forcedArchetype = null) {
    const seed = customSeed !== null ? customSeed : (Math.floor(Date.now() % 1000000) + Math.floor(Math.random() * 89999) + stage * 733);
    const rng = this.createRNG(seed);

    const archetypeIndex = Math.floor(rng() * this.ARCHETYPES.length);
    const archetype = forcedArchetype || this.ARCHETYPES[archetypeIndex];

    let grid = null;
    let attempts = 0;

    while (attempts < 30) {
      attempts++;
      grid = this.createEmptyGrid();
      this.populateMacroArchetype(grid, archetype, rng, stage);
      this.enforceGameRules(grid, rng);

      if (this.validateMacroConnectivity(grid)) {
        break;
      }
    }

    const enemyPool = this.generateEnemyPool(stage, rng);

    return {
      grid: grid,
      archetype: archetype,
      seed: seed,
      stage: stage,
      enemyPool: enemyPool
    };
  },

  setMacroBlock(grid, mx, my, tile) {
    if (mx < 0 || mx >= this.MACRO_COLS || my < 0 || my >= this.MACRO_ROWS) return;
    const x = mx * 2;
    const y = my * 2;
    grid[y][x] = tile;
    grid[y][x + 1] = tile;
    grid[y + 1][x] = tile;
    grid[y + 1][x + 1] = tile;
  },

  getMacroBlock(grid, mx, my) {
    if (mx < 0 || mx >= this.MACRO_COLS || my < 0 || my >= this.MACRO_ROWS) return this.TILES.STEEL;
    return grid[my * 2][mx * 2];
  },

  populateMacroArchetype(grid, archetype, rng, stage) {
    const T = this.TILES;
    const isSymmetric = rng() > 0.2; // 80% symmetrical for classic NES feel

    switch (archetype) {
      case 'SYMMETRICAL_FORTRESS':
        this.genFortress(grid, rng, isSymmetric, stage);
        break;
      case 'RIVER_CROSSING':
        this.genRiverCrossing(grid, rng, stage);
        break;
      case 'URBAN_LABYRINTH':
        this.genUrbanLabyrinth(grid, rng, stage);
        break;
      case 'WINTER_ICE':
        this.genWinterIce(grid, rng, stage);
        break;
      case 'FOREST_AMBUSH':
        this.genForestAmbush(grid, rng, stage);
        break;
      case 'STEEL_BUNKERS':
        this.genSteelBunkers(grid, rng, stage);
        break;
      default:
        this.genFortress(grid, rng, true, stage);
    }

    // The archetypes fill columns 1-11 only; give the side lanes cover too
    this.populateEdges(grid, archetype, rng, stage, !(isSymmetric && archetype !== 'RIVER_CROSSING'));

    // Bilateral horizontal symmetry
    if (isSymmetric && archetype !== 'RIVER_CROSSING') {
      for (let my = 0; my < this.MACRO_ROWS; my++) {
        for (let mx = 0; mx < 6; mx++) {
          const tile = this.getMacroBlock(grid, mx, my);
          this.setMacroBlock(grid, 12 - mx, my, tile);
        }
      }
    }
  },

  // Obstacles along the left/right edge columns (macro x = 0 and 12), rows 2-11.
  // Short wall segments with gaps, in the archetype's own materials, so the side lanes
  // are no longer empty highways. Spawn bays (rows 0-1) stay clear; connectivity is
  // checked afterwards like for the rest of the map.
  populateEdges(grid, archetype, rng, stage, bothSides) {
    const T = this.TILES;
    const palettes = {
      SYMMETRICAL_FORTRESS: [T.BRICK, T.BRICK, T.TREES, T.STEEL],
      RIVER_CROSSING: [T.BRICK, T.TREES, T.BRICK, T.WATER],
      URBAN_LABYRINTH: [T.BRICK, T.BRICK, T.BRICK, T.STEEL],
      WINTER_ICE: [T.ICE, T.BRICK, T.ICE, T.STEEL],
      FOREST_AMBUSH: [T.TREES, T.TREES, T.BRICK, T.BRICK],
      STEEL_BUNKERS: [T.STEEL, T.BRICK, T.BRICK, T.WATER]
    };
    const palette = palettes[archetype] || palettes.SYMMETRICAL_FORTRESS;
    const pick = () => {
      let tile = palette[Math.floor(rng() * palette.length)];
      // Indestructible or impassable tiles only from stage 2, like the archetypes do
      if ((tile === T.STEEL || tile === T.WATER) && stage < 2) tile = T.BRICK;
      return tile;
    };

    const sides = bothSides ? [0, this.MACRO_COLS - 1] : [0];
    sides.forEach(mx => {
      let my = 2;
      while (my <= 11) {
        if (archetype === 'RIVER_CROSSING' && my === 6) { my++; continue; } // keep the river
        if (rng() < 0.55) {
          const len = 1 + Math.floor(rng() * 2); // walls of 1-2 blocks
          const tile = pick();
          for (let k = 0; k < len && my + k <= 11; k++) {
            if (archetype === 'RIVER_CROSSING' && my + k === 6) break;
            this.setMacroBlock(grid, mx, my + k, tile);
          }
          my += len + 1; // always leave a gap after a wall
        } else {
          my++;
        }
      }
    });
  },

  // 1. Symmetrical Fortress
  genFortress(grid, rng, isSymmetric, stage) {
    const T = this.TILES;
    const maxX = isSymmetric ? 7 : this.MACRO_COLS;

    for (let my = 1; my < 11; my++) {
      for (let mx = 1; mx < maxX; mx++) {
        // Skip base and spawn corridors
        if (my >= 10 && (mx >= 3 && mx <= 9)) continue;

        const roll = rng();
        if (roll < 0.38) {
          this.setMacroBlock(grid, mx, my, T.BRICK);
        } else if (roll < 0.48 && stage >= 2) {
          this.setMacroBlock(grid, mx, my, T.STEEL);
        } else if (roll < 0.60) {
          this.setMacroBlock(grid, mx, my, T.TREES);
        } else if (roll < 0.68) {
          this.setMacroBlock(grid, mx, my, T.WATER);
        }
      }
    }
  },

  // 2. River Crossing
  genRiverCrossing(grid, rng, stage) {
    const T = this.TILES;
    const riverY = 6; // Macro row 6 cuts horizontally

    // Fill river across map
    for (let mx = 0; mx < this.MACRO_COLS; mx++) {
      this.setMacroBlock(grid, mx, riverY, T.WATER);
    }

    // 3 Strategic Bridges across the river (Left, Center, Right)
    const bridges = [2, 6, 10];
    bridges.forEach(bx => {
      this.setMacroBlock(grid, bx, riverY, T.EMPTY);
      // Fortified guard towers on bridge banks
      this.setMacroBlock(grid, bx - 1, riverY - 1, T.BRICK);
      this.setMacroBlock(grid, bx + 1, riverY + 1, T.BRICK);
    });

    // Populate upper and lower banks
    for (let my = 1; my < riverY - 1; my += 2) {
      for (let mx = 1; mx < this.MACRO_COLS - 1; mx += 2) {
        if (rng() > 0.35) this.setMacroBlock(grid, mx, my, T.BRICK);
        else if (rng() > 0.5) this.setMacroBlock(grid, mx, my, T.TREES);
      }
    }
    for (let my = riverY + 2; my < 11; my += 2) {
      for (let mx = 1; mx < this.MACRO_COLS - 1; mx += 2) {
        if (rng() > 0.35) this.setMacroBlock(grid, mx, my, T.BRICK);
      }
    }
  },

  // 3. Urban Labyrinth
  genUrbanLabyrinth(grid, rng, stage) {
    const T = this.TILES;
    for (let my = 1; my < 11; my += 2) {
      for (let mx = 1; mx < this.MACRO_COLS - 1; mx += 2) {
        const mat = (rng() < 0.15 && stage >= 2) ? T.STEEL : T.BRICK;
        this.setMacroBlock(grid, mx, my, mat);

        if (rng() < 0.5) {
          this.setMacroBlock(grid, mx + 1, my, mat);
        } else {
          this.setMacroBlock(grid, mx, my + 1, mat);
        }
      }
    }
  },

  // 4. Winter Ice
  genWinterIce(grid, rng, stage) {
    const T = this.TILES;
    for (let my = 2; my < 10; my++) {
      for (let mx = 1; mx < 12; mx++) {
        if (rng() < 0.5) {
          this.setMacroBlock(grid, mx, my, T.ICE);
        }
      }
    }
    for (let my = 1; my < 11; my += 3) {
      for (let mx = 2; mx < 11; mx += 3) {
        this.setMacroBlock(grid, mx, my, T.BRICK);
      }
    }
  },

  // 5. Forest Ambush
  genForestAmbush(grid, rng, stage) {
    const T = this.TILES;
    for (let my = 1; my < 11; my++) {
      for (let mx = 1; mx < 12; mx++) {
        const roll = rng();
        if (roll < 0.45) {
          this.setMacroBlock(grid, mx, my, T.TREES);
        } else if (roll < 0.70) {
          this.setMacroBlock(grid, mx, my, T.BRICK);
        }
      }
    }
  },

  // 6. Steel Bunkers
  genSteelBunkers(grid, rng, stage) {
    const T = this.TILES;
    for (let my = 2; my < 10; my += 2) {
      for (let mx = 2; mx < 11; mx += 2) {
        const roll = rng();
        if (roll < 0.4) {
          this.setMacroBlock(grid, mx, my, T.STEEL);
        } else if (roll < 0.8) {
          this.setMacroBlock(grid, mx, my, T.BRICK);
        } else {
          this.setMacroBlock(grid, mx, my, T.WATER);
        }
      }
    }
  },

  /**
   * Enforce authentic Battle City rules with guaranteed corridors
   */
  enforceGameRules(grid, rng = Math.random) {
    const T = this.TILES;

    // 1. Clear 3 Enemy Spawn Macro-Blocks + exits downwards (my = 0 and my = 1)
    [0, 6, 12].forEach(mx => {
      this.setMacroBlock(grid, mx, 0, T.EMPTY);
      this.setMacroBlock(grid, mx, 1, T.EMPTY);
    });

    // 2. Clear Player 1 Spawn (mx = 4, my = 12) + exit upwards (my = 11, my = 10)
    this.setMacroBlock(grid, 4, 12, T.EMPTY);
    this.setMacroBlock(grid, 4, 11, T.EMPTY);
    this.setMacroBlock(grid, 4, 10, T.EMPTY);

    // 3. Clear Player 2 / Ally Spawn (mx = 8, my = 12) + exit upwards
    this.setMacroBlock(grid, 8, 12, T.EMPTY);
    this.setMacroBlock(grid, 8, 11, T.EMPTY);

    // 4. Clear Base Eagle (mx = 6, my = 12)
    this.setMacroBlock(grid, 6, 12, T.EMPTY);

    // 5. Build Base Protective Bunker (3-sided brick wall)
    this.BASE_FORT_WALLS.forEach(pt => {
      grid[pt.y][pt.x] = T.BRICK;
    });

    // 6. No straight shot at the Eagle from the centre lanes: random guard above the bunker
    this.buildCentreGuard(grid, rng);
  },

  // Guards over columns 10-15, rows 16-21 (6x6 tiles).
  // S steel, B brick, W water, T trees, . empty, ? keep the archetype's tile.
  // Every shape has steel in columns 12 AND 13 on row 20 or 21: that stops shells from
  // all three lanes that can hit the Eagle (11, 12, 13) and leaves no room for a tank below it.
  CENTRE_GUARDS: [
    // Cap
    ['??????',
     '??????',
     '??????',
     '??????',
     '??SS??',
     '??SS??'],
    // Wide bar
    ['??????',
     '??????',
     '??????',
     '??????',
     '??????',
     'SSSSSS'],
    // Inverted T
    ['??????',
     '??????',
     '??SS??',
     '??SS??',
     '??SS??',
     '.SSSS.'],
    // Umbrella on brick legs
    ['??????',
     '??????',
     '??????',
     '??????',
     'SSSSSS',
     'B....B'],
    // Zigzag
    ['??????',
     '??????',
     '??????',
     'SS????',
     '?SS???',
     '??SSSS'],
    // Steel island in a moat
    ['??????',
     '??????',
     '??????',
     '?BBBB?',
     'WWSSWW',
     'WWSSWW'],
    // Brick bunker with steel core
    ['??????',
     '??????',
     '?BBBB?',
     '?BSSB?',
     '?BSSB?',
     '??..??'],
    // Steel under forest cover
    ['??????',
     '??????',
     '??????',
     'TTTTTT',
     '?TSST?',
     '?TSST?'],
    // Tall steel column
    ['??SS??',
     '??SS??',
     '??SS??',
     '??SS??',
     '??SS??',
     '??SS??']
  ],

  buildCentreGuard(grid, rng) {
    const T = this.TILES;
    const tiles = { S: T.STEEL, B: T.BRICK, W: T.WATER, T: T.TREES, '.': T.EMPTY };
    const shape = this.CENTRE_GUARDS[Math.floor(rng() * this.CENTRE_GUARDS.length)];
    const mirror = rng() < 0.5; // Mirroring swaps columns 12/13, so the guarantee holds
    shape.forEach((row, dy) => {
      for (let dx = 0; dx < 6; dx++) {
        const ch = row[mirror ? 5 - dx : dx];
        if (ch !== '?') grid[16 + dy][10 + dx] = tiles[ch];
      }
    });
  },

  /**
   * BFS validation on 13x13 macro-block grid:
   * Guarantees that 26-28px tanks can physically navigate through 32px corridors
   * from top enemy bays down to player and base!
   */
  validateMacroConnectivity(grid) {
    const T = this.TILES;
    const visited = Array.from({ length: 13 }, () => new Uint8Array(13));
    const queue = [];

    // Push all 3 enemy spawn macro-blocks
    [0, 6, 12].forEach(mx => {
      queue.push({ mx: mx, my: 0 });
      visited[0][mx] = 1;
    });

    const dirs = [
      { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
      { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
    ];

    while (queue.length > 0) {
      const cur = queue.shift();

      // Check if reached Player (mx=4, my=12) or Base neighborhood (mx=6, my=11..12)
      if (cur.my >= 11 && (cur.mx >= 3 && cur.mx <= 9)) {
        return true; // Path exists!
      }

      for (const d of dirs) {
        const nx = cur.mx + d.dx;
        const ny = cur.my + d.dy;

        if (nx >= 0 && nx < 13 && ny >= 0 && ny < 13) {
          if (!visited[ny][nx]) {
            const tile = this.getMacroBlock(grid, nx, ny);
            // Passable or breakable: EMPTY, BRICK, TREES, ICE
            if (tile !== T.STEEL && tile !== T.WATER) {
              visited[ny][nx] = 1;
              queue.push({ mx: nx, my: ny });
            }
          }
        }
      }
    }

    return false;
  },

  // Wide map: two classic halves of the same archetype, each with its own Eagle,
  // bunker, spawn bays and centre guard
  generateWide(stage = 1, customSeed = null) {
    const left = this.generate(stage, customSeed);
    const right = this.generate(stage, (left.seed * 7919 + 104729) % 2147483647, left.archetype);
    const grid = [];
    for (let y = 0; y < this.ROWS; y++) {
      const row = new Uint8Array(this.COLS * 2);
      row.set(left.grid[y], 0);
      row.set(right.grid[y], this.COLS);
      grid.push(row);
    }
    const rng = this.createRNG(left.seed + 31);
    return {
      grid: grid,
      archetype: left.archetype,
      seed: left.seed,
      stage: stage,
      enemyPool: this.generateEnemyPool(stage, rng, this.LAYOUTS.big.totalEnemies)
    };
  },

  // -------------------------------------------------------------
  // CONQUEST: one screen (26x26 tiles) of new land. index 0 is the starting area;
  // later chunks may hold an enemy city around a headquarters.
  // -------------------------------------------------------------
  generateConquestChunk(index, seed) {
    const T = this.TILES;
    const rng = this.createRNG(seed);
    const stage = 1 + Math.floor(index / 2);
    for (let attempt = 0; attempt < 12; attempt++) {
      const grid = this.createEmptyGrid();
      const archetype = this.populateConquestLand(grid, rng, stage);

      if (index === 0) {
        // Open ground where the players start
        for (let my = 9; my < this.MACRO_ROWS; my++) {
          for (let mx = 0; mx < this.MACRO_COLS; mx++) this.setMacroBlock(grid, mx, my, T.EMPTY);
        }
      }

      let city = null;
      let citadel = null;
      if (index >= 4 && index % 5 === 4) citadel = this.buildCitadel(grid, rng, stage); // Boss fortress
      else if (index > 0 && rng() < (index === 1 ? 0.5 : 0.7)) city = this.buildCity(grid, rng, stage);

      if (!this.validateVerticalConnectivity(grid)) continue;
      const findCount = index === 0 ? 0 : (rng() < 0.6 ? 1 : 0) + (rng() < 0.25 ? 1 : 0);
      return {
        grid, archetype, city,
        citadel, // { name, hqs: [city-like entries], turrets: [{x, y}] } or null
        finds: this.pickFinds(grid, rng, city || (citadel && citadel.hqs[0]), findCount)
      };
    }
    return { grid: this.createEmptyGrid(), archetype: 'SYMMETRICAL_FORTRESS', city: null, finds: [] };
  },

  // Land for the conquest march: the classic layouts plus travel-friendly ones.
  // Returns the archetype name (it picks the weather: lakes -> mist, ice -> snow, forest -> leaves)
  populateConquestLand(grid, rng, stage) {
    const options = [
      ['SYMMETRICAL_FORTRESS', 1], ['RIVER_CROSSING', 0.8], ['URBAN_LABYRINTH', 0.8],
      ['WINTER_ICE', 0.6], ['FOREST_AMBUSH', 0.7], ['STEEL_BUNKERS', 0.6],
      ['LAKES', 1.3], ['CANYON', 1.2], ['VILLAGE', 1.3], ['DEFENSE_LINE', 1], ['ICE_FIELD', 0.8],
      ['RUINS', 1], ['DEEP_FOREST', 1]
    ];
    let roll = rng() * options.reduce((s, o) => s + o[1], 0);
    let kind = options[0][0];
    for (const [name, w] of options) {
      if (roll < w) { kind = name; break; }
      roll -= w;
    }
    switch (kind) {
      case 'LAKES': this.genLakes(grid, rng, stage); return 'RIVER_CROSSING';
      case 'CANYON': this.genCanyon(grid, rng, stage); return 'CANYON';
      case 'VILLAGE': this.genVillage(grid, rng, stage); return 'VILLAGE';
      case 'DEFENSE_LINE': this.genDefenseLine(grid, rng, stage); return 'DEFENSE_LINE';
      case 'ICE_FIELD': this.genIceField(grid, rng, stage); return 'WINTER_ICE';
      case 'RUINS': this.genRuins(grid, rng, stage); return 'RUINS';
      case 'DEEP_FOREST': this.genDeepForest(grid, rng, stage); return 'FOREST_AMBUSH';
      default:
        this.populateMacroArchetype(grid, kind, rng, stage);
        return kind;
    }
  },

  // Smooth random field on the 13x13 macro grid (bilinear value noise), values 0..1
  smoothNoise(rng, cell = 4) {
    const n = Math.ceil(this.MACRO_COLS / cell) + 2;
    const pts = Array.from({ length: n }, () => Array.from({ length: n }, () => rng()));
    const out = [];
    for (let my = 0; my < this.MACRO_ROWS; my++) {
      out.push([]);
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        const gx = mx / cell;
        const gy = my / cell;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = pts[y0][x0] + (pts[y0][x0 + 1] - pts[y0][x0]) * sx;
        const b = pts[y0 + 1][x0] + (pts[y0 + 1][x0 + 1] - pts[y0 + 1][x0]) * sx;
        out[my].push(a + (b - a) * sy);
      }
    }
    return out;
  },

  // Lakes with tree-lined shores and a few rocks
  genLakes(grid, rng, stage) {
    const T = this.TILES;
    const n = this.smoothNoise(rng, 3 + Math.floor(rng() * 2));
    for (let my = 0; my < this.MACRO_ROWS; my++) {
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        const v = n[my][mx];
        if (v > 0.68) this.setMacroBlock(grid, mx, my, T.WATER);
        else if (v > 0.6) this.setMacroBlock(grid, mx, my, rng() < 0.6 ? T.TREES : T.EMPTY);
        else if (v < 0.2 && rng() < 0.5) this.setMacroBlock(grid, mx, my, stage >= 2 && rng() < 0.3 ? T.STEEL : T.BRICK);
      }
    }
  },

  // A winding pass between cliffs
  genCanyon(grid, rng, stage) {
    const T = this.TILES;
    let center = 4 + Math.floor(rng() * 5);
    for (let my = 0; my < this.MACRO_ROWS; my++) {
      center = Math.max(2, Math.min(10, center + Math.floor(rng() * 3) - 1));
      const width = 3 + Math.floor(rng() * 3);
      const left = center - Math.floor(width / 2);
      const right = left + width - 1;
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        if (mx >= left && mx <= right) {
          if (rng() < 0.12) this.setMacroBlock(grid, mx, my, rng() < 0.5 ? T.TREES : T.BRICK);
        } else if (mx === left - 1 || mx === right + 1) {
          this.setMacroBlock(grid, mx, my, rng() < 0.4 ? T.TREES : T.BRICK);
        } else {
          this.setMacroBlock(grid, mx, my, stage >= 2 && rng() < 0.55 ? T.STEEL : T.BRICK);
        }
      }
    }
  },

  // Small brick houses with gardens and streets
  genVillage(grid, rng, stage) {
    const T = this.TILES;
    const houses = 7 + Math.floor(rng() * 5);
    for (let k = 0; k < houses; k++) {
      const w = 1 + Math.floor(rng() * 2);
      const h = 1 + Math.floor(rng() * 2);
      const mx0 = Math.floor(rng() * (this.MACRO_COLS - w));
      const my0 = Math.floor(rng() * (this.MACRO_ROWS - h));
      const stone = stage >= 2 && rng() < 0.15;
      for (let my = my0; my < my0 + h; my++) {
        for (let mx = mx0; mx < mx0 + w; mx++) this.setMacroBlock(grid, mx, my, stone ? T.STEEL : T.BRICK);
      }
      // Door and windows
      for (let i = 0; i < 2; i++) {
        const x = mx0 * 2 + Math.floor(rng() * w * 2);
        const y = my0 * 2 + Math.floor(rng() * h * 2);
        if (!stone) grid[y][x] = T.EMPTY;
      }
      // Garden next to the house
      const gx = mx0 + (rng() < 0.5 ? -1 : w);
      if (gx >= 0 && gx < this.MACRO_COLS && rng() < 0.5) this.setMacroBlock(grid, gx, my0, T.TREES);
    }
  },

  // One or two fortified lines across the land with pillboxes and gaps
  genDefenseLine(grid, rng, stage) {
    const T = this.TILES;
    const rows = [3 + Math.floor(rng() * 3)];
    if (rng() < 0.45) rows.push(rows[0] + 4 + Math.floor(rng() * 2));
    rows.forEach(my => {
      const gaps = new Set();
      while (gaps.size < 3) gaps.add(Math.floor(rng() * this.MACRO_COLS));
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        if (gaps.has(mx)) continue;
        const pillbox = mx % 4 === 1;
        this.setMacroBlock(grid, mx, my, pillbox && stage >= 2 ? T.STEEL : T.BRICK);
        if (my - 1 >= 0 && rng() < 0.35) this.setMacroBlock(grid, mx, my - 1, T.TREES); // cover in front
      }
    });
    for (let i = 0; i < 8; i++) {
      this.setMacroBlock(grid, Math.floor(rng() * this.MACRO_COLS), Math.floor(rng() * this.MACRO_ROWS), rng() < 0.5 ? T.BRICK : T.TREES);
    }
  },

  // Frozen plain with rocks and small frozen ponds
  genIceField(grid, rng, stage) {
    const T = this.TILES;
    const n = this.smoothNoise(rng, 3);
    for (let my = 0; my < this.MACRO_ROWS; my++) {
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        const v = n[my][mx];
        let tile = rng() < 0.75 ? T.ICE : T.EMPTY;
        if (v > 0.74) tile = stage >= 2 && rng() < 0.5 ? T.STEEL : T.BRICK;
        else if (v < 0.12) tile = T.WATER;
        this.setMacroBlock(grid, mx, my, tile);
      }
    }
  },

  // Ruined town: broken single-tile walls, rubble and a few standing pillars
  genRuins(grid, rng, stage) {
    const T = this.TILES;
    const pieces = 45 + Math.floor(rng() * 30);
    for (let i = 0; i < pieces; i++) {
      const x = Math.floor(rng() * this.COLS);
      const y = Math.floor(rng() * this.ROWS);
      const len = 1 + Math.floor(rng() * 3);
      const horizontal = rng() < 0.5;
      for (let k = 0; k < len; k++) {
        const tx = horizontal ? x + k : x;
        const ty = horizontal ? y : y + k;
        if (tx < this.COLS && ty < this.ROWS) grid[ty][tx] = rng() < 0.85 ? T.BRICK : T.TREES;
      }
    }
    if (stage >= 2) {
      for (let i = 0; i < 4; i++) {
        this.setMacroBlock(grid, Math.floor(rng() * this.MACRO_COLS), Math.floor(rng() * this.MACRO_ROWS), T.STEEL);
      }
    }
  },

  // Thick forest with clearings and a couple of huts
  genDeepForest(grid, rng, stage) {
    const T = this.TILES;
    const n = this.smoothNoise(rng, 3);
    for (let my = 0; my < this.MACRO_ROWS; my++) {
      for (let mx = 0; mx < this.MACRO_COLS; mx++) {
        if (n[my][mx] > 0.42) this.setMacroBlock(grid, mx, my, T.TREES);
        else if (rng() < 0.12) this.setMacroBlock(grid, mx, my, T.BRICK);
      }
    }
    if (stage >= 2 && rng() < 0.5) {
      this.setMacroBlock(grid, Math.floor(rng() * this.MACRO_COLS), Math.floor(rng() * this.MACRO_ROWS), T.WATER);
    }
  },

  // City names: Russian-sounding syllables, e.g. КРАСНОГОРСК, ЗАРЕЧЬЕ, БЕЛОДАР
  cityName(rng) {
    const pick = list => list[Math.floor(rng() * list.length)];
    const roots = ['КРАС', 'ВОЛ', 'БЕЛ', 'СЕВЕР', 'ЗАР', 'ОСТ', 'ГОР', 'ЛЕС', 'КАМЕН', 'ТУР', 'МИР', 'СОЛ',
      'ДУБ', 'ЯР', 'ЗВЕН', 'ТИХ', 'БОР', 'СНЕЖ', 'ЧЕР', 'ЖЕЛЕЗ', 'ГРОМ', 'ЛУГ', 'РЕЧ', 'СТАЛ', 'ВЕТР'];
    const links = ['О', 'Е', 'И', ''];
    const ends = ['ГРАД', 'ГОРСК', 'ПОЛЬ', 'СК', 'ОВ', 'ИНСК', 'ЕЦ', 'ИНО', 'ДАР', 'МИР', 'ЬЕ', 'АНЬ', 'ОВКА', 'ЕВО'];
    let name = pick(roots);
    const end = pick(ends);
    if (/^[ОЕАИЬ]/.test(end) || /[ОЕАИ]$/.test(name)) name += end;
    else name += pick(links) + end;
    return name.slice(0, 12);
  },

  // Enemy city around a headquarters (HQ). The HQ can stand anywhere in the chunk;
  // the layout is one of: walled 'fort', steel 'bunker' behind a moat with bridges,
  // forest 'camp' with sandbag rings, or dense 'town' with steel-cornered blocks.
  buildCity(grid, rng, stage) {
    const T = this.TILES;
    const hmx = 1 + Math.floor(rng() * 11); // HQ macro cell 1..11
    const hmy = 1 + Math.floor(rng() * 10); // 1..10
    const templates = stage >= 2 ? ['fort', 'bunker', 'camp', 'town'] : ['fort', 'camp', 'town'];
    const template = templates[Math.floor(rng() * templates.length)];
    const zx0 = Math.max(0, hmx - 3);
    const zx1 = Math.min(this.MACRO_COLS - 1, hmx + 3);
    const zy0 = Math.max(0, hmy - 3);
    const zy1 = Math.min(this.MACRO_ROWS - 1, hmy + 3);
    const sides = ['top', 'bottom', 'left', 'right'];
    const gate = sides[Math.floor(rng() * 4)];
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[gate];
    const isSide = (side, dx, dy) =>
      (side === 'top' && dx === 0 && dy < 0) || (side === 'bottom' && dx === 0 && dy > 0) ||
      (side === 'left' && dy === 0 && dx < 0) || (side === 'right' && dy === 0 && dx > 0);

    for (let my = zy0; my <= zy1; my++) {
      for (let mx = zx0; mx <= zx1; mx++) {
        const dx = mx - hmx;
        const dy = my - hmy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        const corner = Math.abs(dx) === Math.abs(dy);
        const roll = rng();
        let tile = T.EMPTY;
        if (template === 'fort') {
          if (ring === 1) tile = isSide(gate, dx, dy) ? T.EMPTY : (corner && stage >= 2 ? T.STEEL : T.BRICK);
          else if (ring === 3) tile = roll < 0.55 ? T.BRICK : roll < 0.68 && stage >= 2 ? T.STEEL : roll < 0.8 ? T.TREES : T.EMPTY;
        } else if (template === 'bunker') {
          if (ring === 1) tile = isSide(gate, dx, dy) || isSide(opposite, dx, dy) ? T.EMPTY : T.STEEL;
          else if (ring === 2) tile = isSide(gate, dx, dy) || isSide(opposite, dx, dy) ? T.EMPTY : T.WATER; // moat + bridges
          else if (ring === 3) tile = roll < 0.35 ? T.TREES : roll < 0.55 ? T.BRICK : T.EMPTY;
        } else if (template === 'camp') {
          if (ring === 1) tile = roll < 0.7 && !isSide(gate, dx, dy) ? T.BRICK : T.EMPTY;
          else if (ring >= 2) tile = roll < 0.45 ? T.TREES : roll < 0.6 ? T.BRICK : T.EMPTY;
        } else { // town
          if (ring === 1) tile = isSide(gate, dx, dy) ? T.EMPTY : T.BRICK;
          else if (ring === 3) tile = corner && stage >= 2 ? T.STEEL : roll < 0.8 ? T.BRICK : T.EMPTY;
          else if (ring === 2 && corner) tile = T.BRICK;
        }
        this.setMacroBlock(grid, mx, my, tile);
      }
    }
    // HQ cell itself, and entrances in the middle of each outer side
    this.setMacroBlock(grid, hmx, hmy, T.EMPTY);
    [[0, -3], [0, 3], [-3, 0], [3, 0]].forEach(([dx, dy]) => this.setMacroBlock(grid, hmx + dx, hmy + dy, T.EMPTY));
    // Town: windows knocked into the outer houses (single tiles, decoration)
    if (template === 'town') {
      for (let i = 0; i < 10; i++) {
        const x = zx0 * 2 + Math.floor(rng() * (zx1 - zx0 + 1) * 2);
        const y = zy0 * 2 + Math.floor(rng() * (zy1 - zy0 + 1) * 2);
        if (grid[y] && grid[y][x] === T.BRICK) grid[y][x] = T.EMPTY;
      }
    }

    const spawns = [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2]]
      .map(([dx, dy]) => ({ x: (hmx + dx) * 2, y: (hmy + dy) * 2 }))
      .filter(s => s.x >= 0 && s.x <= this.COLS - 2 && s.y >= 0 && s.y <= this.ROWS - 2 &&
        this.getMacroBlock(grid, s.x / 2, s.y / 2) !== T.WATER && this.getMacroBlock(grid, s.x / 2, s.y / 2) !== T.STEEL);
    spawns.forEach(s => this.setMacroBlock(grid, s.x / 2, s.y / 2, T.EMPTY));

    return {
      name: this.cityName(rng),
      template,
      hq: { x: hmx * 2, y: hmy * 2 },
      zone: { x: zx0 * 2, y: zy0 * 2, w: (zx1 - zx0 + 1) * 2, h: (zy1 - zy0 + 1) * 2 },
      spawns,
      garrison: Math.min(5, 2 + Math.floor(stage / 2)),
      hp: 5 + Math.min(5, stage)
    };
  },

  // Boss fortress: an outer wall across most of the chunk with gates top and bottom,
  // two or three headquarters in their own walled yards, and gun turrets on the wall.
  // The fortress falls only when every headquarters is destroyed.
  buildCitadel(grid, rng, stage) {
    const T = this.TILES;
    const x0 = 1;
    const x1 = 11;
    const y0 = 2;
    const y1 = 10;
    for (let my = y0; my <= y1; my++) {
      for (let mx = x0; mx <= x1; mx++) {
        const border = mx === x0 || mx === x1 || my === y0 || my === y1;
        let tile = T.EMPTY;
        if (border) tile = stage >= 2 && (mx + my) % 3 === 0 ? T.STEEL : T.BRICK;
        else if (rng() < 0.08) tile = T.TREES;
        this.setMacroBlock(grid, mx, my, tile);
      }
    }
    // Gates
    this.setMacroBlock(grid, 6, y0, T.EMPTY);
    this.setMacroBlock(grid, 6, y1, T.EMPTY);
    this.setMacroBlock(grid, x0, 6, T.BRICK);
    this.setMacroBlock(grid, x1, 6, T.BRICK);

    const hqCells = stage >= 3 ? [[3, 6], [6, 4], [9, 6]] : [[4, 6], [8, 6]];
    const name = this.cityName(rng);
    const hqs = hqCells.map(([hmx, hmy]) => {
      // Inner yard around each HQ, gate facing the middle of the fortress
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const towardCenter = (hmx < 6 && dx === 1 && dy === 0) || (hmx > 6 && dx === -1 && dy === 0) ||
                               (hmx === 6 && dy === 1 && dx === 0);
          this.setMacroBlock(grid, hmx + dx, hmy + dy, towardCenter ? T.EMPTY : (Math.abs(dx) === Math.abs(dy) && stage >= 2 ? T.STEEL : T.BRICK));
        }
      }
      this.setMacroBlock(grid, hmx, hmy, T.EMPTY);
      const spawns = [[0, 2], [2, 0], [-2, 0], [0, -2]]
        .map(([dx, dy]) => ({ x: (hmx + dx) * 2, y: (hmy + dy) * 2 }))
        .filter(s => s.x / 2 > x0 && s.x / 2 < x1 && s.y / 2 > y0 && s.y / 2 < y1);
      spawns.forEach(s => this.setMacroBlock(grid, s.x / 2, s.y / 2, T.EMPTY));
      return {
        name,
        template: 'citadel',
        hq: { x: hmx * 2, y: hmy * 2 },
        zone: { x: x0 * 2, y: y0 * 2, w: (x1 - x0 + 1) * 2, h: (y1 - y0 + 1) * 2 },
        spawns,
        garrison: 2,
        hp: 6 + Math.min(6, stage)
      };
    });

    // Turrets sit on wall cells (one per 32px cell); the cell under them is cleared
    const turretCells = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [4, y1], [8, y1], [4, y0], [8, y0]]
      .slice(0, 4 + Math.min(4, stage));
    const turrets = turretCells.map(([mx, my]) => {
      this.setMacroBlock(grid, mx, my, T.EMPTY);
      return { x: mx * 2, y: my * 2 };
    });
    return { name, hqs, turrets };
  },

  // A path for tanks from the bottom edge of the chunk to its top edge
  validateVerticalConnectivity(grid) {
    const T = this.TILES;
    const passable = (mx, my) => {
      const t = this.getMacroBlock(grid, mx, my);
      return t !== T.STEEL && t !== T.WATER;
    };
    const visited = Array.from({ length: this.MACRO_ROWS }, () => new Uint8Array(this.MACRO_COLS));
    const queue = [];
    for (let mx = 0; mx < this.MACRO_COLS; mx++) {
      if (passable(mx, this.MACRO_ROWS - 1)) {
        visited[this.MACRO_ROWS - 1][mx] = 1;
        queue.push([mx, this.MACRO_ROWS - 1]);
      }
    }
    while (queue.length) {
      const [mx, my] = queue.shift();
      if (my === 0) return true;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const nx = mx + dx;
        const ny = my + dy;
        if (nx < 0 || nx >= this.MACRO_COLS || ny < 0 || ny >= this.MACRO_ROWS || visited[ny][nx]) return;
        if (!passable(nx, ny)) return;
        visited[ny][nx] = 1;
        queue.push([nx, ny]);
      });
    }
    return false;
  },

  // Bonuses lying on the ground waiting to be found (tile coords, top-left of 2x2)
  pickFinds(grid, rng, city, count) {
    const T = this.TILES;
    const finds = [];
    for (let attempt = 0; attempt < 60 && finds.length < count; attempt++) {
      const x = Math.floor(rng() * (this.COLS - 1));
      const y = Math.floor(rng() * (this.ROWS - 1));
      const tiles = [grid[y][x], grid[y][x + 1], grid[y + 1][x], grid[y + 1][x + 1]];
      if (tiles.some(t => t === T.STEEL || t === T.WATER || t === T.BRICK)) continue;
      if (city && x >= city.hq.x - 2 && x <= city.hq.x + 3 && y >= city.hq.y - 2 && y <= city.hq.y + 3) continue;
      finds.push({ x, y });
    }
    return finds;
  },

  generateEnemyPool(stage, rng, totalTanks = 20) {
    const pool = [];
    const scale = totalTanks / 20;

    // Same mix as the classic 20-tank stage, scaled to the pool size
    let basicCount = Math.round(Math.max(4, 14 - Math.floor(stage * 1.5)) * scale);
    let fastCount = Math.round(Math.min(8, 3 + Math.floor(stage * 0.8)) * scale);
    let powerCount = Math.round(Math.min(6, 2 + Math.floor(stage * 0.6)) * scale);
    let armorCount = Math.round(Math.min(8, Math.max(1, stage)) * scale);

    let currentTotal = basicCount + fastCount + powerCount + armorCount;
    while (currentTotal > totalTanks) {
      if (basicCount > 2) basicCount--;
      else if (fastCount > 2) fastCount--;
      else armorCount--;
      currentTotal = basicCount + fastCount + powerCount + armorCount;
    }
    while (currentTotal < totalTanks) {
      basicCount++;
      currentTotal++;
    }

    for (let i = 0; i < basicCount; i++) pool.push({ type: 'basic', hp: 1, points: 100, isFlashing: false });
    for (let i = 0; i < fastCount; i++) pool.push({ type: 'fast', hp: 1, points: 200, isFlashing: false });
    for (let i = 0; i < powerCount; i++) pool.push({ type: 'power', hp: 1, points: 300, isFlashing: false });
    for (let i = 0; i < armorCount; i++) pool.push({ type: 'armor', hp: 4, points: 400, isFlashing: false });

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const bonusIndices = [];
    for (let i = 3; i < totalTanks; i += 7) bonusIndices.push(i); // 3, 10, 17 (+24 on big maps)
    if (stage >= 3) bonusIndices.push(7);

    bonusIndices.forEach(idx => {
      if (pool[idx]) {
        pool[idx].isFlashing = true;
      }
    });

    return pool;
  }
};
