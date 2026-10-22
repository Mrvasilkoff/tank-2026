/**
 * TANK 2026 - Modern HD Procedural Sprite & FX Engine
 * High-definition procedural rendering for tiles, tanks, lighting, and particles.
 * Designed for crisp 2x Retina canvas scaling with dynamic 3D relief, metallic shaders,
 * animated fluid caustics, volumetric canopy foliage, and cinematic combat FX.
 */

const Sprites = {
  TILE_SIZE: 16,  // Logical 16px tile
  BLOCK_SIZE: 32, // Logical 32px block
  TANK_SIZE: 28,  // Logical tank dimensions
  TEX: 64,        // Terrain texture resolution per 16px logical tile
  WATER_FRAMES: 8,

  // Offscreen pre-rendered textures (rendered at 32x32 for 2x retina subpixel sharpness)
  cache: {},
  waterPhases: [],

  init() {
    this.createStaticSprites();
  },

  createStaticSprites() {
    // 1. Terrain Textures (32x32 high-res rendered, drawn at 16x16 logical)
    this.cache['brick'] = this.renderHDBrickTile();
    this.cache['steel'] = this.renderHDSteelTile();
    
    // Water animation phases for smooth looping waves
    for (let i = 0; i < this.WATER_FRAMES; i++) {
      this.cache['water' + i] = this.renderHDWaterTile(i);
    }

    this.cache['trees'] = this.renderHDFoliageTile();
    this.cache['ice'] = this.renderHDIceTile();

    // Conquest ground per land type (seamless, one 16px tile each)
    ['grass', 'sand', 'snow', 'cobble', 'dirt'].forEach(kind => {
      this.cache['ground_' + kind] = this.renderGroundTile(kind);
    });

    // 2. Base Phoenix / Eagle Monuments (64x64 high-res, drawn at 32x32 logical)
    this.cache['eagle_alive'] = this.renderHDEagle(false);
    this.cache['eagle_dead'] = this.renderHDEagle(true);
    this.cache['eagle_enemy'] = this.tintCanvas(this.cache['eagle_alive'], 'rgba(220, 30, 30, 0.6)'); // Enemy city HQ

    // 3. High-Tech Holographic Power-Up Badges (60x60 high-res, drawn at 30x30)
    const bonuses = ['star', 'helmet', 'clock', 'shovel', 'grenade', 'tank', 'gun', 'boat'];
    bonuses.forEach(b => {
      this.cache['bonus_' + b] = this.renderHDPowerUp(b);
    });
  },

  // Copy of a sprite with a colour laid over its opaque pixels
  tintCanvas(src, color) {
    const { canvas, ctx } = this.makeCanvas(src.width, src.height);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, src.width, src.height);
    return canvas;
  },

  makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    return { canvas: c, ctx: ctx };
  },

  // Terrain textures are drawn in 32-unit coordinates onto a TEX x TEX canvas,
  // so tiles stay sharp on large screens (one 16px logical tile = TEX px).
  makeTileCanvas() {
    const { canvas, ctx } = this.makeCanvas(this.TEX, this.TEX);
    ctx.scale(this.TEX / 32, this.TEX / 32);
    return { canvas, ctx };
  },

  // Small deterministic RNG so every texture looks the same on every load
  seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  },

  roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  },

  // -------------------------------------------------------------
  // GROUND for the conquest march: grass, sand, snow, cobblestone, dirt.
  // Dark and low-contrast so tanks, walls and shells stay easy to read.
  // -------------------------------------------------------------
  renderGroundTile(kind) {
    const { canvas, ctx } = this.makeTileCanvas();
    const rnd = this.seededRandom({ grass: 11, sand: 22, snow: 33, cobble: 44, dirt: 55 }[kind] || 1);
    const base = { grass: '#1c3319', sand: '#3a3222', snow: '#5b6772', cobble: '#262a30', dirt: '#2c241c' }[kind];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 32, 32);

    // Blotches drawn with wrap-around so neighbouring tiles join seamlessly
    const blot = (x, y, r, color) => {
      [-32, 0, 32].forEach(ox => [-32, 0, 32].forEach(oy => {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }));
    };

    if (kind === 'grass') {
      for (let i = 0; i < 6; i++) blot(rnd() * 32, rnd() * 32, 6 + rnd() * 6, rnd() < 0.5 ? 'rgba(60, 100, 40, 0.35)' : 'rgba(10, 25, 10, 0.4)');
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 40; i++) {
        const x = rnd() * 32;
        const y = rnd() * 32;
        ctx.strokeStyle = rnd() < 0.6 ? 'rgba(110, 160, 70, 0.45)' : 'rgba(40, 70, 30, 0.6)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rnd() - 0.5) * 1.5, y - 1.5 - rnd() * 1.5);
        ctx.stroke();
      }
    } else if (kind === 'sand') {
      for (let i = 0; i < 6; i++) blot(rnd() * 32, rnd() * 32, 7 + rnd() * 6, rnd() < 0.5 ? 'rgba(120, 100, 60, 0.3)' : 'rgba(20, 15, 8, 0.35)');
      // Wind ripples
      ctx.strokeStyle = 'rgba(150, 125, 80, 0.25)';
      ctx.lineWidth = 0.6;
      for (let y = 3; y < 32; y += 6) {
        ctx.beginPath();
        for (let x = -1; x <= 33; x += 2) {
          const yy = y + Math.sin((x / 32) * Math.PI * 4 + y) * 0.9;
          if (x === -1) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      for (let i = 0; i < 50; i++) {
        ctx.fillStyle = rnd() < 0.5 ? 'rgba(170, 145, 95, 0.35)' : 'rgba(15, 10, 5, 0.35)';
        ctx.fillRect(rnd() * 32, rnd() * 32, 0.5, 0.5);
      }
    } else if (kind === 'snow') {
      for (let i = 0; i < 7; i++) blot(rnd() * 32, rnd() * 32, 6 + rnd() * 7, rnd() < 0.5 ? 'rgba(200, 220, 240, 0.25)' : 'rgba(40, 55, 75, 0.3)');
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(235, 245, 255, ${0.25 + rnd() * 0.35})`;
        ctx.fillRect(rnd() * 32, rnd() * 32, 0.6, 0.6);
      }
    } else if (kind === 'cobble') {
      // Rounded stones in staggered rows (two rows per 16 logical px)
      for (let row = 0; row < 4; row++) {
        const y = row * 8;
        const shift = row % 2 ? 4 : 0;
        for (let col = -1; col < 4; col++) {
          const x = col * 8 + shift;
          const shade = 38 + Math.floor(rnd() * 16);
          ctx.fillStyle = `rgb(${shade}, ${shade + 3}, ${shade + 8})`;
          this.roundRectPath(ctx, x + 0.6, y + 0.6, 6.8, 6.8, 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.fillRect(x + 1.4, y + 1.2, 4.5, 0.6);
        }
      }
    } else { // dirt
      for (let i = 0; i < 7; i++) blot(rnd() * 32, rnd() * 32, 5 + rnd() * 7, rnd() < 0.5 ? 'rgba(90, 70, 45, 0.35)' : 'rgba(10, 6, 3, 0.4)');
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = rnd() < 0.5 ? 'rgba(110, 95, 75, 0.45)' : 'rgba(15, 10, 6, 0.5)';
        ctx.beginPath();
        ctx.arc(rnd() * 32, rnd() * 32, 0.4 + rnd() * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return canvas;
  },

  // -------------------------------------------------------------
  // 1. BRICK: running-bond clay bricks with colour variation, rounded edges,
  //    recessed mortar, grain and chipped corners
  // -------------------------------------------------------------
  renderHDBrickTile() {
    const { canvas, ctx } = this.makeTileCanvas();
    const rnd = this.seededRandom(1990);

    // Recessed mortar
    const mortar = ctx.createLinearGradient(0, 0, 0, 32);
    mortar.addColorStop(0, '#3b2a20');
    mortar.addColorStop(1, '#24170f');
    ctx.fillStyle = mortar;
    ctx.fillRect(0, 0, 32, 32);

    // Rows match the 8x8 sub-quadrants that bullets chip away
    const brickRows = [
      [{ x: 0.6, w: 14.8 }, { x: 16.6, w: 14.8 }],
      [{ x: 0.6, w: 6.8 }, { x: 8.6, w: 14.8 }, { x: 24.6, w: 6.8 }],
      [{ x: 0.6, w: 14.8 }, { x: 16.6, w: 14.8 }],
      [{ x: 0.6, w: 6.8 }, { x: 8.6, w: 14.8 }, { x: 24.6, w: 6.8 }]
    ];
    const clays = [
      ['#d2603a', '#a8401f', '#7a2a12'],
      ['#c4552f', '#9c3a1c', '#6e240f'],
      ['#db6b42', '#b14822', '#823015'],
      ['#b94d2a', '#8f3419', '#64200c'],
      ['#cf5b34', '#a33d1d', '#752811']
    ];

    brickRows.forEach((row, rIdx) => {
      const y = 0.7 + rIdx * 8;
      const h = 6.6;
      row.forEach(b => {
        const [c0, c1, c2] = clays[Math.floor(rnd() * clays.length)];

        // Shadow cast into the mortar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        this.roundRectPath(ctx, b.x + 0.5, y + 0.6, b.w, h, 1);
        ctx.fill();

        // Clay body
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, c0);
        grad.addColorStop(0.55, c1);
        grad.addColorStop(1, c2);
        ctx.fillStyle = grad;
        this.roundRectPath(ctx, b.x, y, b.w, h, 1);
        ctx.fill();

        // Grain: light and dark specks
        for (let i = 0; i < b.w * 0.9; i++) {
          const sx = b.x + 0.8 + rnd() * (b.w - 1.6);
          const sy = y + 1 + rnd() * (h - 2);
          ctx.fillStyle = rnd() < 0.5 ? 'rgba(255, 210, 170, 0.18)' : 'rgba(60, 15, 5, 0.25)';
          ctx.fillRect(sx, sy, 0.6, 0.6);
        }

        // Bevel: lit top-left, shaded bottom-right
        ctx.fillStyle = 'rgba(255, 196, 160, 0.55)';
        ctx.fillRect(b.x + 0.8, y + 0.4, b.w - 1.6, 0.7);
        ctx.fillStyle = 'rgba(255, 196, 160, 0.25)';
        ctx.fillRect(b.x + 0.4, y + 0.8, 0.6, h - 1.6);
        ctx.fillStyle = 'rgba(40, 10, 4, 0.55)';
        ctx.fillRect(b.x + 0.8, y + h - 0.9, b.w - 1.6, 0.6);

        // Occasional chipped corner
        if (rnd() < 0.35) {
          ctx.fillStyle = 'rgba(30, 18, 12, 0.85)';
          const cx = rnd() < 0.5 ? b.x + 0.4 : b.x + b.w - 1.6;
          ctx.beginPath();
          ctx.arc(cx + 0.6, y + h - 0.8, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });

    return canvas;
  },

  // -------------------------------------------------------------
  // 2. STEEL: four riveted armour plates with raised centres and a polished sheen
  // -------------------------------------------------------------
  renderHDSteelTile() {
    const { canvas, ctx } = this.makeTileCanvas();

    const drawPlate = (px, py) => {
      const s = 16;
      // Seam
      ctx.fillStyle = '#12161d';
      ctx.fillRect(px, py, s, s);

      // Plate body
      const body = ctx.createLinearGradient(px, py, px + s, py + s);
      body.addColorStop(0, '#c3ccd8');
      body.addColorStop(0.45, '#8b96a6');
      body.addColorStop(1, '#565f6d');
      ctx.fillStyle = body;
      this.roundRectPath(ctx, px + 0.6, py + 0.6, s - 1.2, s - 1.2, 1.2);
      ctx.fill();

      // Bevel edges (light top-left, dark bottom-right)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillRect(px + 1.4, py + 0.9, s - 2.8, 0.7);
      ctx.fillRect(px + 0.9, py + 1.4, 0.7, s - 2.8);
      ctx.fillStyle = 'rgba(15, 20, 28, 0.75)';
      ctx.fillRect(px + 1.4, py + s - 1.6, s - 2.8, 0.7);
      ctx.fillRect(px + s - 1.6, py + 1.4, 0.7, s - 2.8);

      // Raised centre panel (reverse gradient reads as a pressed boss)
      const boss = ctx.createLinearGradient(px + 4, py + 4, px + 12, py + 12);
      boss.addColorStop(0, '#6f7a8a');
      boss.addColorStop(0.5, '#b8c2cf');
      boss.addColorStop(1, '#e6ecf3');
      ctx.fillStyle = 'rgba(10, 14, 20, 0.45)';
      this.roundRectPath(ctx, px + 4.3, py + 4.3, 8, 8, 1);
      ctx.fill();
      ctx.fillStyle = boss;
      this.roundRectPath(ctx, px + 4, py + 4, 8, 8, 1);
      ctx.fill();

      // Diagonal polished sheen
      ctx.save();
      this.roundRectPath(ctx, px + 0.6, py + 0.6, s - 1.2, s - 1.2, 1.2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.beginPath();
      ctx.moveTo(px + 2, py + s);
      ctx.lineTo(px + s, py + 2);
      ctx.lineTo(px + s, py + 5);
      ctx.lineTo(px + 5, py + s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Rivets
      [[3, 3], [13, 3], [3, 13], [13, 13]].forEach(([rx, ry]) => {
        ctx.fillStyle = 'rgba(10, 12, 16, 0.6)';
        ctx.beginPath();
        ctx.arc(px + rx + 0.3, py + ry + 0.3, 1.1, 0, Math.PI * 2);
        ctx.fill();
        const rv = ctx.createRadialGradient(px + rx - 0.4, py + ry - 0.4, 0.1, px + rx, py + ry, 1.1);
        rv.addColorStop(0, '#ffffff');
        rv.addColorStop(0.5, '#c9d2de');
        rv.addColorStop(1, '#5d6674');
        ctx.fillStyle = rv;
        ctx.beginPath();
        ctx.arc(px + rx, py + ry, 1, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    drawPlate(0, 0);
    drawPlate(16, 0);
    drawPlate(0, 16);
    drawPlate(16, 16);
    return canvas;
  },

  // -------------------------------------------------------------
  // 3. WATER: seamless animated waves (patterns repeat every 16/32 units,
  //    so neighbouring tiles join into one surface)
  // -------------------------------------------------------------
  renderHDWaterTile(frame) {
    const { canvas, ctx } = this.makeTileCanvas();
    const phase = (frame / this.WATER_FRAMES) * Math.PI * 2;
    const TAU = Math.PI * 2;

    const base = ctx.createLinearGradient(0, 0, 0, 32);
    base.addColorStop(0, '#0c3478');
    base.addColorStop(0.5, '#0f4596');
    base.addColorStop(1, '#0c3478');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 32, 32);

    // Soft depth bands
    for (let y = 0; y < 32; y += 8) {
      const band = ctx.createLinearGradient(0, y, 0, y + 8);
      band.addColorStop(0, 'rgba(40, 120, 220, 0.0)');
      band.addColorStop(0.5, 'rgba(40, 140, 230, 0.18)');
      band.addColorStop(1, 'rgba(40, 120, 220, 0.0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, y, 32, 8);
    }

    const wave = (y0, amp, k, ph, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = -1; x <= 33; x += 1) {
        const y = y0 + Math.sin((x / 32) * TAU * k + ph) * amp;
        if (x === -1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    ctx.lineCap = 'round';
    [2, 10, 18, 26].forEach((y0, i) => {
      // Trough shadow, then the lit crest just above it
      wave(y0 + 1.4, 1.5, 2, phase + i * 1.7, 'rgba(5, 20, 60, 0.45)', 1.4);
      wave(y0, 1.5, 2, phase + i * 1.7, 'rgba(120, 200, 255, 0.55)', 1.1);
    });
    [6, 14, 22, 30].forEach((y0, i) => {
      wave(y0, 0.9, 4, -phase * 2 + i * 2.3, 'rgba(170, 235, 255, 0.28)', 0.7);
    });

    // Drifting sparkles (wrap around, stays seamless)
    const sparkles = [[3, 5], [19, 9], [11, 17], [27, 21], [6, 27], [22, 29]];
    sparkles.forEach(([sx, sy], i) => {
      const t = (frame + i * 3) % this.WATER_FRAMES;
      const alpha = Math.max(0, Math.sin((t / this.WATER_FRAMES) * Math.PI));
      if (alpha < 0.05) return;
      const x = (sx + frame * (32 / this.WATER_FRAMES)) % 32; // one full wrap per loop
      ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * alpha})`;
      ctx.fillRect(x - 1.2, sy - 0.3, 2.4, 0.6);
      ctx.fillRect(x - 0.3, sy - 1.2, 0.6, 2.4);
    });

    return canvas;
  },

  // -------------------------------------------------------------
  // 4. FOREST CANOPY: layered leaf clusters, wraps across tile edges
  // -------------------------------------------------------------
  renderHDFoliageTile() {
    const { canvas, ctx } = this.makeTileCanvas();
    const rnd = this.seededRandom(2026);

    ctx.fillStyle = '#0a3410';
    ctx.fillRect(0, 0, 32, 32);

    // Draw a blob and its wrapped copies so the canopy is seamless
    const blob = (x, y, r, inner, mid, outer) => {
      [-32, 0, 32].forEach(ox => [-32, 0, 32].forEach(oy => {
        const cx = x + ox;
        const cy = y + oy;
        if (cx + r < 0 || cx - r > 32 || cy + r < 0 || cy - r > 32) return;
        ctx.fillStyle = 'rgba(2, 16, 4, 0.55)';
        ctx.beginPath();
        ctx.arc(cx + 0.8, cy + 1.2, r, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
        g.addColorStop(0, inner);
        g.addColorStop(0.6, mid);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }));
    };

    // Back layer (darker), then front layer (brighter)
    for (let i = 0; i < 10; i++) {
      blob(rnd() * 32, rnd() * 32, 4.5 + rnd() * 2.5, '#2f9a35', '#1b6e22', '#0c4012');
    }
    for (let i = 0; i < 9; i++) {
      blob(rnd() * 32, rnd() * 32, 3 + rnd() * 2, '#6fe06a', '#33a83a', '#17661e');
    }

    // Individual leaf highlights
    for (let i = 0; i < 26; i++) {
      const x = rnd() * 32;
      const y = rnd() * 32;
      ctx.fillStyle = rnd() < 0.6 ? 'rgba(170, 255, 150, 0.55)' : 'rgba(10, 60, 15, 0.6)';
      ctx.beginPath();
      ctx.ellipse(x, y, 0.9, 0.5, rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    return canvas;
  },

  // -------------------------------------------------------------
  // 5. ICE: glossy frozen sheet with frost speckles, fine cracks and reflections
  //    (a moving glint is added at draw time in GameMap.render)
  // -------------------------------------------------------------
  renderHDIceTile() {
    const { canvas, ctx } = this.makeTileCanvas();
    const rnd = this.seededRandom(77);

    const grad = ctx.createLinearGradient(0, 0, 32, 32);
    grad.addColorStop(0, '#d9f1ff');
    grad.addColorStop(0.5, '#b4dcf5');
    grad.addColorStop(1, '#cdeaff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);

    // Frozen depth: faint blue cloud patches
    for (let i = 0; i < 6; i++) {
      const x = rnd() * 32;
      const y = rnd() * 32;
      const g = ctx.createRadialGradient(x, y, 0.5, x, y, 6);
      g.addColorStop(0, 'rgba(110, 170, 220, 0.28)');
      g.addColorStop(1, 'rgba(110, 170, 220, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 6, y - 6, 12, 12);
    }

    // Diagonal reflections
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, 12); ctx.lineTo(12, 0); ctx.lineTo(16, 0); ctx.lineTo(0, 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(10, 32); ctx.lineTo(32, 10); ctx.lineTo(32, 13); ctx.lineTo(13, 32);
    ctx.closePath();
    ctx.fill();

    // Fine cracks (shadow line under a bright line)
    const crack = (pts) => {
      ['rgba(70, 120, 170, 0.45)', 'rgba(255, 255, 255, 0.9)'].forEach((color, i) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = i ? 0.45 : 0.8;
        ctx.beginPath();
        pts.forEach(([x, y], j) => (j ? ctx.lineTo(x + (i ? 0 : 0.4), y + (i ? 0 : 0.4)) : ctx.moveTo(x, y)));
        ctx.stroke();
      });
    };
    crack([[3, 4], [9, 11], [15, 10], [21, 17], [29, 19]]);
    crack([[9, 11], [10, 19], [6, 26]]);
    crack([[21, 17], [24, 26], [27, 30]]);
    crack([[15, 10], [19, 4]]);

    // Frost speckles
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + rnd() * 0.5})`;
      ctx.fillRect(rnd() * 32, rnd() * 32, 0.5, 0.5);
    }

    // Soft edge bevel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(0, 0, 32, 0.6);
    ctx.fillRect(0, 0, 0.6, 32);
    ctx.fillStyle = 'rgba(60, 110, 160, 0.3)';
    ctx.fillRect(0, 31.4, 32, 0.6);
    ctx.fillRect(31.4, 0, 0.6, 32);

    return canvas;
  },

  // -------------------------------------------------------------
  // 6. HD BASE MONUMENT (64x64 Texture for 32x32 Logical Monument)
  // Gilded Golden Eagle sculpture on dark granite pedestal, ruby eyes
  // -------------------------------------------------------------
  renderHDEagle(destroyed) {
    const { canvas, ctx } = this.makeCanvas(64, 64);

    if (destroyed) {
      // Scorched ruined granite pedestal
      const pedGrad = ctx.createLinearGradient(8, 20, 56, 56);
      pedGrad.addColorStop(0, '#1c1c20');
      pedGrad.addColorStop(1, '#0e0e12');
      ctx.fillStyle = pedGrad;
      ctx.fillRect(8, 24, 48, 36);

      // Cracked fractures in stone
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 28); ctx.lineTo(28, 42); ctx.lineTo(40, 34); ctx.lineTo(52, 50);
      ctx.moveTo(28, 42); ctx.lineTo(24, 58);
      ctx.stroke();

      // Molten glowing embers
      ctx.fillStyle = '#ff3d00';
      ctx.fillRect(26, 40, 4, 4);
      ctx.fillRect(38, 32, 5, 3);
      ctx.fillRect(18, 48, 3, 3);
      ctx.fillStyle = '#ffab00';
      ctx.fillRect(27, 41, 2, 2);

      // Charred eagle remains
      ctx.fillStyle = '#2a2622';
      ctx.beginPath();
      ctx.arc(32, 26, 14, 0, Math.PI * 2);
      ctx.fill();

      // Surrender Flag on steel staff
      ctx.strokeStyle = '#7c8594';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(24, 56); ctx.lineTo(24, 6);
      ctx.stroke();

      // White ragged cloth flag
      ctx.fillStyle = '#e8ecf2';
      ctx.beginPath();
      ctx.moveTo(26, 8);
      ctx.lineTo(48, 14);
      ctx.lineTo(44, 26);
      ctx.lineTo(26, 22);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a0aab8';
      ctx.fillRect(26, 14, 18, 2);

      return canvas;
    }

    // ALIVE: Majestic Gilded Phoenix / Imperial Golden Eagle
    // 1. Granite Pedestal
    const pedGrad = ctx.createLinearGradient(6, 44, 58, 62);
    pedGrad.addColorStop(0, '#3a3d47');
    pedGrad.addColorStop(0.5, '#25272e');
    pedGrad.addColorStop(1, '#15161a');
    ctx.fillStyle = pedGrad;
    ctx.fillRect(6, 46, 52, 16);

    // Pedestal gold trim
    ctx.fillStyle = '#f8b800';
    ctx.fillRect(6, 44, 52, 3);
    ctx.fillStyle = '#fff275';
    ctx.fillRect(6, 44, 52, 1);

    // 2. Wings (Majestic spread with golden feather tiers)
    // Wing base shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.arc(32, 28, 24, 0, Math.PI * 2);
    ctx.fill();

    // Outer golden feathers
    const wingGrad = ctx.createRadialGradient(32, 20, 4, 32, 28, 26);
    wingGrad.addColorStop(0, '#fff480');
    wingGrad.addColorStop(0.35, '#f5ba18');
    wingGrad.addColorStop(0.75, '#c98206');
    wingGrad.addColorStop(1, '#663c00');
    ctx.fillStyle = wingGrad;

    // Left Wing
    ctx.beginPath();
    ctx.moveTo(32, 18);
    ctx.lineTo(4, 12);
    ctx.lineTo(2, 28);
    ctx.lineTo(12, 38);
    ctx.lineTo(32, 44);
    ctx.closePath();
    ctx.fill();

    // Right Wing
    ctx.beginPath();
    ctx.moveTo(32, 18);
    ctx.lineTo(60, 12);
    ctx.lineTo(62, 28);
    ctx.lineTo(52, 38);
    ctx.lineTo(32, 44);
    ctx.closePath();
    ctx.fill();

    // Feather ribs and metallic highlights
    ctx.strokeStyle = '#fff8b0';
    ctx.lineWidth = 1.5;
    for (let f = 0; f < 4; f++) {
      // Left feather accents
      ctx.beginPath();
      ctx.moveTo(30, 24 + f * 4);
      ctx.lineTo(8 + f * 4, 18 + f * 4);
      ctx.stroke();
      // Right feather accents
      ctx.beginPath();
      ctx.moveTo(34, 24 + f * 4);
      ctx.lineTo(56 - f * 4, 18 + f * 4);
      ctx.stroke();
    }

    // 3. Central Heraldic Crest / Breast Shield
    ctx.fillStyle = '#b71c1c';
    ctx.beginPath();
    ctx.moveTo(32, 20);
    ctx.lineTo(42, 24);
    ctx.lineTo(40, 38);
    ctx.lineTo(32, 45);
    ctx.lineTo(24, 38);
    ctx.lineTo(22, 24);
    ctx.closePath();
    ctx.fill();

    // Crest gold star
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(32, 32, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(30, 27, 4, 10);
    ctx.fillRect(27, 30, 10, 4);

    // 4. Eagle Head & Crown
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(32, 12, 7, 0, Math.PI * 2);
    ctx.fill();

    // Golden Eagle Beak
    ctx.fillStyle = '#ff8f00';
    ctx.beginPath();
    ctx.moveTo(32, 14);
    ctx.lineTo(38, 16);
    ctx.lineTo(32, 19);
    ctx.lineTo(26, 16);
    ctx.closePath();
    ctx.fill();

    // Glowing Ruby Eyes
    ctx.fillStyle = '#ff1744';
    ctx.beginPath();
    ctx.arc(29, 11, 1.8, 0, Math.PI * 2);
    ctx.arc(35, 11, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(28.5, 10.5, 1, 1);
    ctx.fillRect(34.5, 10.5, 1, 1);

    return canvas;
  },

  // -------------------------------------------------------------
  // 7. HD HOLOGRAPHIC POWER-UP BADGES (60x60 Texture for 30x30 Logical)
  // Glassmorphic neon medallion with pulsing aura and bevel
  // -------------------------------------------------------------
  renderHDPowerUp(type) {
    const { canvas, ctx } = this.makeCanvas(60, 60);

    // Outer neon glow ring
    const bgGrad = ctx.createRadialGradient(30, 30, 12, 30, 30, 28);
    bgGrad.addColorStop(0, '#151924');
    bgGrad.addColorStop(0.7, '#0b0e17');
    bgGrad.addColorStop(1, '#05070a');
    ctx.fillStyle = bgGrad;
    ctx.beginPath();
    ctx.arc(30, 30, 26, 0, Math.PI * 2);
    ctx.fill();

    // Glowing gold/cyan rim
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(30, 30, 26, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(30, 30, 24, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Icon Centered (scale up by 2)
    ctx.save();
    ctx.translate(30, 30);
    ctx.scale(1.8, 1.8);

    switch (type) {
      case 'star': {
        // Blazing 5-point Gold Star
        ctx.fillStyle = '#ffea00';
        ctx.shadowColor = '#ffab00';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        const spikes = 5, outerR = 9, innerR = 4;
        let rot = (Math.PI / 2) * 3;
        const step = Math.PI / spikes;
        ctx.moveTo(0, -outerR);
        for (let i = 0; i < spikes; i++) {
          let x = Math.cos(rot) * outerR;
          let y = Math.sin(rot) * outerR;
          ctx.lineTo(x, y);
          rot += step;
          x = Math.cos(rot) * innerR;
          y = Math.sin(rot) * innerR;
          ctx.lineTo(x, y);
          rot += step;
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-1.5, -2, 3, 3);
        break;
      }
      case 'helmet': {
        // Holographic Defense Dome
        ctx.fillStyle = '#00e5ff';
        ctx.shadowColor = '#00e5ff';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(0, -2, 8, Math.PI, 0, false);
        ctx.lineTo(7, 5);
        ctx.lineTo(0, 9);
        ctx.lineTo(-7, 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-4, -4, 8, 3);
        break;
      }
      case 'clock': {
        // Chrono Freeze Stopwatch
        ctx.fillStyle = '#ff1744';
        ctx.beginPath();
        ctx.arc(0, 1, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 1, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#10141a';
        ctx.fillRect(-1, -3, 2, 5);
        ctx.fillRect(-1, 0, 4, 2);
        ctx.fillStyle = '#ffd700';
        ctx.fillRect(-2, -9, 4, 3);
        break;
      }
      case 'shovel': {
        // Titanium Fortress Spade
        ctx.fillStyle = '#cfd8dc';
        ctx.fillRect(-5, -7, 10, 7);
        ctx.beginPath();
        ctx.moveTo(-5, 0); ctx.lineTo(0, 6); ctx.lineTo(5, 0); ctx.fill();
        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(-1, -1, 2, 8);
        ctx.fillStyle = '#ff1744';
        ctx.fillRect(-3, 6, 6, 2.5);
        break;
      }
      case 'grenade': {
        // Tactical EMP Grenade
        ctx.fillStyle = '#2e7d32';
        ctx.fillRect(-5, -3, 10, 10);
        ctx.fillStyle = '#1b5e20';
        ctx.fillRect(-4, -2, 8, 8);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-1, -3, 2, 10);
        ctx.fillRect(-5, 2, 10, 2);
        ctx.fillStyle = '#ffd700';
        ctx.fillRect(-2, -7, 4, 4);
        break;
      }
      case 'tank': {
        // Extra Life Mini-Titan
        ctx.fillStyle = '#ffb300';
        ctx.fillRect(-5, -2, 10, 8);
        ctx.fillRect(-7, -4, 3, 12);
        ctx.fillRect(4, -4, 3, 12);
        ctx.fillRect(-1, -7, 2, 6);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-2, 0, 4, 4);
        break;
      }
      case 'gun': {
        // High-Caliber Automatic Pistol
        ctx.fillStyle = '#eceff1';
        ctx.fillRect(-6, -4, 12, 4);
        ctx.fillRect(0, 0, 5, 7);
        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(1, 1, 3, 5);
        ctx.fillStyle = '#ffd700';
        ctx.fillRect(-3, 0, 3, 2.5);
        break;
      }
      case 'boat': {
        // Amphibious Assault Hydrofoil
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath();
        ctx.moveTo(-8, 1); ctx.lineTo(8, 1); ctx.lineTo(5, 7); ctx.lineTo(-5, 7);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-3, -4, 6, 5);
        ctx.fillStyle = '#ff1744';
        ctx.fillRect(-1, -7, 2, 3);
        break;
      }
    }

    ctx.restore();
    return canvas;
  },

  // -------------------------------------------------------------
  // 8. MODERN HD TANK RENDERING ENGINE
  // Dynamic multi-layer hull, animated caterpillar tread links,
  // 3D turret mantlet, rotating barrel with recoil, warm halogen headlights
  // -------------------------------------------------------------
  drawTank(ctx, x, y, options) {
    const {
      type = 'player',    // 'player' or 'basic', 'fast', 'power', 'armor'
      tier = 1,           // 1 to 4 for player
      direction = 'UP',   // UP, RIGHT, DOWN, LEFT
      trackAnim = 0,      // 0 or 1 (legacy)
      trackPos = null,    // Distance driven in px: scrolls the track links
      isFlashing = false, // for bonus tanks
      armorHp = 1,        // 1 to 4 for armor tank
      hasShield = false,
      hasBoat = false,
      shieldPhase = 0,
      recoil = 0,
      muzzleFlash = false,
      barrelSide = 0,
      playerIndex = 0     // 0: player I (gold), 1: player II (green)
    } = options;

    ctx.save();
    ctx.translate(x + 14, y + 14);

    // Rotate according to direction
    let angle = 0;
    if (direction === 'RIGHT') angle = Math.PI / 2;
    else if (direction === 'DOWN') angle = Math.PI;
    else if (direction === 'LEFT') angle = -Math.PI / 2;
    ctx.rotate(angle);

    // Visual recoil kickback along firing axis
    if (recoil > 0) {
      ctx.translate(0, recoil);
    }

    // 0. Forward Halogen Headlights (cast soft light on the battlefield ground!)
    const hlGrad = ctx.createRadialGradient(0, -14, 2, 0, -32, 28);
    hlGrad.addColorStop(0, 'rgba(255, 240, 180, 0.5)');
    hlGrad.addColorStop(0.5, 'rgba(255, 220, 120, 0.2)');
    hlGrad.addColorStop(1, 'rgba(255, 200, 50, 0)');
    ctx.fillStyle = hlGrad;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(-14, -36);
    ctx.lineTo(14, -36);
    ctx.closePath();
    ctx.fill();

    // 1. Chassis Drop Shadow (elevation off ground)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 14, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Determine Color Schemes
    let primary = '#ffb300';
    let secondary = '#d48800';
    let highlight = '#ffe082';
    let darkShadow = '#7f4f00';
    let trackBase = '#1a1d24';
    let trackLink = '#424956';

    if (type === 'player' && playerIndex === 2) {
      // Player III: blue hull family (big map)
      if (tier === 1) {
        primary = '#42a5f5'; secondary = '#1e6fc2'; highlight = '#bbdefb'; darkShadow = '#0b3566';
      } else if (tier === 2) {
        primary = '#29b6f6'; secondary = '#0277bd'; highlight = '#b3e5fc'; darkShadow = '#01385c';
      } else if (tier === 3) {
        primary = '#5c6bc0'; secondary = '#3949ab'; highlight = '#c5cae9'; darkShadow = '#1a237e';
      } else {
        primary = '#80d8ff'; secondary = '#40a4d8'; highlight = '#e1f5fe'; darkShadow = '#0d3c5a';
      }
    } else if (type === 'player' && playerIndex === 3) {
      // Player IV: pink hull family (big map)
      if (tier === 1) {
        primary = '#ec4fa0'; secondary = '#b02a72'; highlight = '#f8bbd9'; darkShadow = '#5a0f36';
      } else if (tier === 2) {
        primary = '#f06292'; secondary = '#c2185b'; highlight = '#f8bbd0'; darkShadow = '#5c0a2a';
      } else if (tier === 3) {
        primary = '#ab47bc'; secondary = '#7b1fa2'; highlight = '#e1bee7'; darkShadow = '#3a0a4a';
      } else {
        primary = '#ff80ab'; secondary = '#d3477a'; highlight = '#ffd6e6'; darkShadow = '#5e1430';
      }
    } else if (type === 'player' && playerIndex === 1) {
      // Player II: classic green hull family
      if (tier === 1) {
        primary = '#43c94b'; secondary = '#2a8f31'; highlight = '#b9f6ca'; darkShadow = '#0f4a14';
      } else if (tier === 2) {
        primary = '#8bc34a'; secondary = '#5a8a24'; highlight = '#dcedc8'; darkShadow = '#2c4a0c';
      } else if (tier === 3) {
        primary = '#1de9b6'; secondary = '#00a884'; highlight = '#a7ffeb'; darkShadow = '#00453a';
      } else {
        primary = '#c6ff00'; secondary = '#8fb800'; highlight = '#f4ff81'; darkShadow = '#3d4f00';
      }
    } else if (type === 'player') {
      if (tier === 1) {
        primary = '#ffb300'; secondary = '#cf8200'; highlight = '#fff3a0'; darkShadow = '#784600';
      } else if (tier === 2) {
        primary = '#ff6f00'; secondary = '#c43e00'; highlight = '#ffb74d'; darkShadow = '#662200';
      } else if (tier === 3) {
        primary = '#00bcd4'; secondary = '#008ba3'; highlight = '#80deea'; darkShadow = '#004d40';
      } else {
        // Tier 4: Steel Destroyer Overlord (Emerald Heavy Battle Tank)
        primary = '#2e7d32'; secondary = '#1b5e20'; highlight = '#a5d6a7'; darkShadow = '#0a310c';
      }
    } else {
      // Enemy Tanks
      if (isFlashing && (Math.floor(Date.now() / 120) % 2 === 0)) {
        // Blinking Red/White High-Value Bonus Tank
        primary = '#ff1744'; secondary = '#b71c1c'; highlight = '#ffffff'; darkShadow = '#5f0909';
      } else if (type === 'basic') {
        primary = '#78909c'; secondary = '#455a64'; highlight = '#b0bec5'; darkShadow = '#263238';
      } else if (type === 'fast') {
        primary = '#90a4ae'; secondary = '#546e7a'; highlight = '#cfd8dc'; darkShadow = '#37474f';
      } else if (type === 'power') {
        primary = '#ff7043'; secondary = '#d84315'; highlight = '#ffab91'; darkShadow = '#4e1505';
      } else if (type === 'armor') {
        if (armorHp >= 4) {
          primary = '#2e7d32'; secondary = '#1b5e20'; highlight = '#81c784'; darkShadow = '#0a310c';
        } else if (armorHp === 3) {
          primary = '#fbc02d'; secondary = '#f57f17'; highlight = '#fff59d'; darkShadow = '#684500';
        } else if (armorHp === 2) {
          primary = '#f57c00'; secondary = '#e65100'; highlight = '#ffcc80'; darkShadow = '#662200';
        } else {
          primary = '#b0bec5'; secondary = '#607d8b'; highlight = '#eceff1'; darkShadow = '#263238';
        }
      }
    }

    // -------------------------------------------------------------
    // AUTHENTIC NES CHASSIS & TURRET GEOMETRY BY TANK TYPE
    // -------------------------------------------------------------

    // 2. Caterpillar tracks: shoes scroll continuously with the distance driven
    const travel = trackPos !== null ? trackPos : trackAnim * 1.5;
    const drawTrackSegment = (tx, ty, tw, th) => {
      const r = Math.min(tw / 2, 2.5);
      const trackShape = () => {
        ctx.beginPath();
        ctx.moveTo(tx + r, ty);
        ctx.lineTo(tx + tw - r, ty);
        ctx.quadraticCurveTo(tx + tw, ty, tx + tw, ty + r);
        ctx.lineTo(tx + tw, ty + th - r);
        ctx.quadraticCurveTo(tx + tw, ty + th, tx + tw - r, ty + th);
        ctx.lineTo(tx + r, ty + th);
        ctx.quadraticCurveTo(tx, ty + th, tx, ty + th - r);
        ctx.lineTo(tx, ty + r);
        ctx.quadraticCurveTo(tx, ty, tx + r, ty);
        ctx.closePath();
      };

      ctx.save();
      trackShape();
      // Rounded rubber-and-steel belt (cylindrical shading across its width)
      const belt = ctx.createLinearGradient(tx, 0, tx + tw, 0);
      belt.addColorStop(0, '#07080c');
      belt.addColorStop(0.3, trackLink);
      belt.addColorStop(0.5, '#59626f');
      belt.addColorStop(0.7, trackLink);
      belt.addColorStop(1, '#07080c');
      ctx.fillStyle = belt;
      ctx.fill();
      ctx.clip();

      // Track shoes: the upper run moves forward relative to the hull
      const pitch = 3;
      const shift = ((travel % pitch) + pitch) % pitch;
      for (let yPos = ty - shift; yPos < ty + th + pitch; yPos += pitch) {
        ctx.fillStyle = 'rgba(4, 5, 8, 0.85)';
        ctx.fillRect(tx, yPos, tw, 0.8);
        ctx.fillStyle = 'rgba(205, 215, 230, 0.32)';
        ctx.fillRect(tx + 0.4, yPos + 0.9, tw - 0.8, 0.55);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(tx + tw / 2 - 0.5, yPos + 1.2, 1, 1.1); // guide horn
      }

      // Drive sprocket and idler at the ends spin with the track
      const wheelR = tw / 2 - 0.6;
      const angle = -travel / Math.max(1, wheelR);
      const cx = tx + tw / 2;
      [ty + wheelR + 0.5, ty + th - wheelR - 0.5].forEach(wy => {
        ctx.fillStyle = '#151920';
        ctx.beginPath();
        ctx.arc(cx, wy, wheelR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(170, 180, 195, 0.7)';
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = angle + k * Math.PI / 3;
          ctx.moveTo(cx + Math.cos(a) * wheelR * 0.35, wy + Math.sin(a) * wheelR * 0.35);
          ctx.lineTo(cx + Math.cos(a) * wheelR, wy + Math.sin(a) * wheelR);
        }
        ctx.stroke();
        ctx.fillStyle = '#9aa5b4';
        ctx.beginPath();
        ctx.arc(cx, wy, Math.max(0.5, wheelR * 0.3), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // Crisp outline
      trackShape();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    };

    if (type === 'fast') {
      // Fast Tank / APC: Sleek, narrow high-speed tracks
      drawTrackSegment(-11, -12, 4.5, 24);
      drawTrackSegment(6.5, -12, 4.5, 24);
    } else if (type === 'armor') {
      // Armor Tank: Massive, extra wide heavy tracks with protective mudguards
      drawTrackSegment(-14, -13, 6.5, 26);
      drawTrackSegment(7.5, -13, 6.5, 26);
      // Heavy track mudguards
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-14.5, -14, 7.5, 2.5);
      ctx.fillRect(-14.5, 11.5, 7.5, 2.5);
      ctx.fillRect(7, -14, 7.5, 2.5);
      ctx.fillRect(7, 11.5, 7.5, 2.5);
    } else if (type === 'power') {
      // Power Tank: Broad assault tracks
      drawTrackSegment(-13, -12.5, 5.5, 25);
      drawTrackSegment(7.5, -12.5, 5.5, 25);
    } else {
      // Basic & Player Standard Tracks
      drawTrackSegment(-12.5, -12.5, 5.5, 25);
      drawTrackSegment(7, -12.5, 5.5, 25);
    }

    // Armored side-skirts for Tier 4 Destroyer and Armor Dreadnought
    if (type === 'player' && tier >= 4) {
      ctx.fillStyle = secondary;
      ctx.fillRect(-14, -8, 2, 18);
      ctx.fillRect(12, -8, 2, 18);
      ctx.fillStyle = highlight;
      ctx.fillRect(-14, -8, 1, 18);
      ctx.fillRect(13, -8, 1, 18);
    } else if (type === 'armor') {
      ctx.fillStyle = secondary;
      ctx.fillRect(-15, -7, 2, 16);
      ctx.fillRect(13, -7, 2, 16);
      ctx.fillStyle = highlight;
      ctx.fillRect(-15, -7, 1, 16);
      ctx.fillRect(14, -7, 1, 16);
    }

    // 3. Main Hull Body (Unique Authentic Silhouette per Type)
    if (type === 'fast') {
      // --- FAST TANK (APC): Narrow, streamlined, wedge-shaped reconnaissance hull ---
      const fastHullGrad = ctx.createLinearGradient(-6, -12, 6, 12);
      fastHullGrad.addColorStop(0, highlight);
      fastHullGrad.addColorStop(0.3, primary);
      fastHullGrad.addColorStop(0.8, secondary);
      fastHullGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = fastHullGrad;

      // Aerodynamic sloped front wedge
      ctx.beginPath();
      ctx.moveTo(0, -13);        // Pointed front nose
      ctx.lineTo(6, -8);         // Sloped front right
      ctx.lineTo(6, 11);         // Rear right
      ctx.lineTo(-6, 11);        // Rear left
      ctx.lineTo(-6, -8);        // Sloped front left
      ctx.closePath();
      ctx.fill();

      // Front wedge bevel highlight
      ctx.strokeStyle = highlight;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-6, -8);
      ctx.lineTo(0, -13);
      ctx.lineTo(6, -8);
      ctx.stroke();

      // Slender engine vents
      ctx.fillStyle = '#10141a';
      ctx.fillRect(-4, 5, 8, 4);
      ctx.fillStyle = '#455a64';
      ctx.fillRect(-3.5, 6, 7, 1);
      ctx.fillRect(-3.5, 8, 7, 1);

      // Single center LED halogen light
      ctx.fillStyle = '#80deea';
      ctx.fillRect(-1.5, -12, 3, 1.5);

    } else if (type === 'armor') {
      // --- ARMOR TANK: Massive, ultra-wide reinforced fortress juggernaut hull ---
      const armorHullGrad = ctx.createLinearGradient(-9, -11, 9, 12);
      armorHullGrad.addColorStop(0, highlight);
      armorHullGrad.addColorStop(0.35, primary);
      armorHullGrad.addColorStop(0.8, secondary);
      armorHullGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = armorHullGrad;

      // Extra broad heavy armored glacis
      ctx.fillRect(-9, -10.5, 18, 22);

      // 3D Heavy armor plate bevels
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(-9, -10.5, 18, 2);
      ctx.fillRect(-9, -10.5, 2, 22);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(-9, 9.5, 18, 2);
      ctx.fillRect(7, -10.5, 2, 22);

      // Heavy steel armor bolts / rivets (corners)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-8, -9, 1.5, 1.5);
      ctx.fillRect(6.5, -9, 1.5, 1.5);
      ctx.fillRect(-8, 8, 1.5, 1.5);
      ctx.fillRect(6.5, 8, 1.5, 1.5);

      // Dual heavy exhaust grills
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(-7.5, 4.5, 6, 4.5);
      ctx.fillRect(1.5, 4.5, 6, 4.5);
      ctx.fillStyle = '#37474f';
      ctx.fillRect(-7, 5.5, 5, 1);
      ctx.fillRect(-7, 7.5, 5, 1);
      ctx.fillRect(2, 5.5, 5, 1);
      ctx.fillRect(2, 7.5, 5, 1);

      // Dual heavy searchlights
      ctx.fillStyle = '#fff9c4';
      ctx.fillRect(-8, -11.5, 3, 2);
      ctx.fillRect(5, -11.5, 3, 2);

    } else if (type === 'power') {
      // --- POWER TANK: Angular wedge assault hull with forward sloped armor ---
      const powerHullGrad = ctx.createLinearGradient(-7.5, -11, 7.5, 12);
      powerHullGrad.addColorStop(0, highlight);
      powerHullGrad.addColorStop(0.3, primary);
      powerHullGrad.addColorStop(0.8, secondary);
      powerHullGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = powerHullGrad;

      // Angular assault hull
      ctx.fillRect(-7.5, -10, 15, 21);

      // Forward armor shield plate
      ctx.fillStyle = secondary;
      ctx.fillRect(-6.5, -11.5, 13, 2.5);
      ctx.fillStyle = highlight;
      ctx.fillRect(-6.5, -11.5, 13, 1);

      // Engine vents
      ctx.fillStyle = '#10141a';
      ctx.fillRect(-5.5, 4.5, 11, 4);
      ctx.fillStyle = '#bf360c';
      ctx.fillRect(-5, 5.5, 10, 1);
      ctx.fillRect(-5, 7, 10, 1);

      // Dual headlights
      ctx.fillStyle = '#ffe082';
      ctx.fillRect(-6.5, -11, 2, 1.5);
      ctx.fillRect(4.5, -11, 2, 1.5);

    } else {
      // --- BASIC TANK & PLAYER: Authentic clean armored battle hull ---
      const hullGrad = ctx.createLinearGradient(-7.5, -10.5, 7.5, 12);
      hullGrad.addColorStop(0, highlight);
      hullGrad.addColorStop(0.3, primary);
      hullGrad.addColorStop(0.8, secondary);
      hullGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = hullGrad;
      ctx.fillRect(-7.5, -10, 15, 21);

      // 3D Hull bevel borders
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillRect(-7.5, -10, 15, 1.5);
      ctx.fillRect(-7.5, -10, 1.5, 21);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(-7.5, 9.5, 15, 1.5);
      ctx.fillRect(6, -10, 1.5, 21);

      // Engine deck vents
      ctx.fillStyle = '#10141a';
      ctx.fillRect(-5.5, 4, 11, 4);
      ctx.fillStyle = '#3a4250';
      for (let vy = 4.5; vy < 8; vy += 1.5) {
        ctx.fillRect(-5, vy, 10, 0.8);
      }

      // Dual headlights
      ctx.fillStyle = '#fff9c4';
      ctx.fillRect(-6.5, -11, 2.5, 1.5);
      ctx.fillRect(4, -11, 2.5, 1.5);
    }

    // 4. Turrets (Unique Authentic Profile per Type)
    if (type === 'fast') {
      // Fast Tank: Low-profile diamond / arrowhead aerodynamic turret
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, -1);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-4.5, -1);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = darkShadow;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Periscope
      ctx.fillStyle = highlight;
      ctx.fillRect(-1, -2, 2, 2);

    } else if (type === 'armor') {
      // Armor Tank: Massive octagonal armored bunker turret
      const bTurretGrad = ctx.createRadialGradient(-1, -1, 1, 0, 0, 8);
      bTurretGrad.addColorStop(0, highlight);
      bTurretGrad.addColorStop(0.4, primary);
      bTurretGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = bTurretGrad;

      // Octagonal bunker turret
      ctx.beginPath();
      ctx.moveTo(-4, -6.5);
      ctx.lineTo(4, -6.5);
      ctx.lineTo(7, -3);
      ctx.lineTo(7, 3);
      ctx.lineTo(4, 5.5);
      ctx.lineTo(-4, 5.5);
      ctx.lineTo(-7, 3);
      ctx.lineTo(-7, -3);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#0d1017';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Dual armored commander hatches
      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.arc(-2.5, -0.5, 2.2, 0, Math.PI * 2);
      ctx.arc(2.5, -0.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = highlight;
      ctx.fillRect(-3, -1, 1.2, 1.2);
      ctx.fillRect(2, -1, 1.2, 1.2);

    } else if (type === 'power') {
      // Power Tank: Angular faceted sniper turret with elevated optic sight
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.moveTo(-5, -6);
      ctx.lineTo(5, -6);
      ctx.lineTo(6, 2);
      ctx.lineTo(-6, 2);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = darkShadow;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Long optical laser rangefinder / sniper periscope
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-1.5, -5, 3, 2);
      ctx.fillStyle = '#ff1744';
      ctx.fillRect(-0.8, -4.5, 1.6, 1);

    } else {
      // Basic Tank & Player: Classic circular mantlet & cupola
      const turretGrad = ctx.createRadialGradient(-1, -2, 1, 0, 0, 6);
      turretGrad.addColorStop(0, highlight);
      turretGrad.addColorStop(0.5, primary);
      turretGrad.addColorStop(1, darkShadow);
      ctx.fillStyle = turretGrad;
      ctx.beginPath();
      ctx.arc(0, -1, 5.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#12161f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, -1, 5.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.arc(0, -1, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = highlight;
      ctx.fillRect(-1, -1.8, 2, 1.8);
    }

    // 5. Cannon Barrels (Unique Visuals per Tank Type)
    if (type === 'player' && tier >= 4) {
      // Player Tier 4: Reinforced Dual Siege Destroyer Cannons
      ctx.fillStyle = secondary;
      ctx.fillRect(-4.5, -19, 3.5, 13);
      ctx.fillStyle = highlight;
      ctx.fillRect(-4.5, -19, 1.2, 13);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-5.5, -21.5, 5, 3);
      ctx.fillStyle = '#fff';
      ctx.fillRect(-4.5, -21, 3, 1);

      ctx.fillStyle = secondary;
      ctx.fillRect(1.0, -19, 3.5, 13);
      ctx.fillStyle = highlight;
      ctx.fillRect(1.0, -19, 1.2, 13);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(0.5, -21.5, 5, 3);
      ctx.fillStyle = '#fff';
      ctx.fillRect(1.5, -21, 3, 1);

    } else if (type === 'player' && tier === 3) {
      // Player Tier 3: Twin Rapid Assault Cannons
      ctx.fillStyle = secondary;
      ctx.fillRect(-4.5, -17, 3, 11);
      ctx.fillStyle = highlight;
      ctx.fillRect(-4.5, -17, 1, 11);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-5, -19, 4, 2.5);

      ctx.fillStyle = secondary;
      ctx.fillRect(1.5, -17, 3, 11);
      ctx.fillStyle = highlight;
      ctx.fillRect(1.5, -17, 1, 11);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(1, -19, 4, 2.5);

    } else if (type === 'fast') {
      // Fast Tank: Needle-sleek rapid-fire cannon
      ctx.fillStyle = secondary;
      ctx.fillRect(-1.5, -18, 3, 12);
      ctx.fillStyle = highlight;
      ctx.fillRect(-1.5, -18, 1, 12);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-2, -19.5, 4, 2);

    } else if (type === 'power') {
      // Power Tank: Massive Long-Barreled High-Velocity Sniper Cannon
      ctx.fillStyle = secondary;
      ctx.fillRect(-2.2, -21, 4.4, 15);
      ctx.fillStyle = highlight;
      ctx.fillRect(-2.2, -21, 1.5, 15);
      // Heavy double-chamber muzzle brake
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-3.5, -23.5, 7, 3);
      ctx.fillStyle = '#fff';
      ctx.fillRect(-2, -23, 4, 1);
      // Muzzle bore
      ctx.fillStyle = '#000';
      ctx.fillRect(-1.5, -24, 3, 1);

    } else if (type === 'armor') {
      // Armor Tank: Heavy High-Caliber Howitzer Cannon
      ctx.fillStyle = secondary;
      ctx.fillRect(-2.8, -18, 5.6, 12);
      ctx.fillStyle = highlight;
      ctx.fillRect(-2.8, -18, 1.8, 12);
      // Massive heavy steel muzzle brake
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-4, -20.5, 8, 3.5);
      ctx.fillStyle = highlight;
      ctx.fillRect(-3, -20, 6, 1);

    } else if (type === 'player' && tier === 2) {
      // Player Tier 2: Sleek Long Barrel
      ctx.fillStyle = secondary;
      ctx.fillRect(-2, -19, 4, 13);
      ctx.fillStyle = highlight;
      ctx.fillRect(-2, -19, 1.5, 13);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-3, -21, 6, 3);
      ctx.fillStyle = '#fff';
      ctx.fillRect(-1.5, -20.5, 3, 1);

    } else {
      // Basic Tank & Player Tier 1: Compact Standard Stubby Cannon
      ctx.fillStyle = secondary;
      ctx.fillRect(-2, -16, 4, 10);
      ctx.fillStyle = highlight;
      ctx.fillRect(-2, -16, 1.2, 10);
      ctx.fillStyle = darkShadow;
      ctx.fillRect(-2.5, -17.5, 5, 2);
    }

    // Fiery Muzzle Flash Bloom on Firing
    if (muzzleFlash) {
      const flashY = (tier >= 2 || type === 'power' || type === 'fast') ? -23 : -19;
      const flashX = (tier >= 3 && type === 'player') ? (barrelSide * 3) : 0;
      ctx.save();
      ctx.translate(flashX, flashY);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffb300';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff9100';
      ctx.beginPath();
      ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 6. Amphibious Pontoons (if boat active)
    if (hasBoat) {
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(-15, -12, 2.5, 24);
      ctx.fillRect(12.5, -12, 2.5, 24);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-15, -12, 1, 24);
      ctx.fillRect(14, -12, 1, 24);
    }

    ctx.restore();

    // 7. Energy shield bubble: fresnel edge, drifting hex lattice, two rotating arcs
    if (hasShield) {
      ctx.save();
      ctx.translate(x + 14, y + 14);
      const r = 18 + Math.sin(shieldPhase * 0.35) * 1.2;

      // Translucent dome, bright towards the rim
      const dome = ctx.createRadialGradient(-4, -5, 2, 0, 0, r);
      dome.addColorStop(0, 'rgba(180, 250, 255, 0.10)');
      dome.addColorStop(0.65, 'rgba(0, 200, 255, 0.10)');
      dome.addColorStop(0.92, 'rgba(0, 229, 255, 0.35)');
      dome.addColorStop(1, 'rgba(220, 255, 255, 0.75)');
      ctx.fillStyle = dome;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // Hex lattice inside the bubble, slowly drifting
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = `rgba(120, 240, 255, ${0.16 + Math.sin(shieldPhase * 0.8) * 0.06})`;
      ctx.lineWidth = 0.5;
      const hs = 4.2;
      const drift = (shieldPhase * 0.6) % (hs * 1.5);
      ctx.beginPath();
      for (let row = -6; row <= 6; row++) {
        for (let col = -5; col <= 5; col++) {
          const cx = col * hs * 1.5 + drift;
          const cy = row * hs * 1.732 + (col % 2 ? hs * 0.866 : 0);
          for (let k = 0; k <= 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const px = cx + Math.cos(a) * hs;
            const py = cy + Math.sin(a) * hs;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
        }
      }
      ctx.stroke();
      ctx.restore();

      // Rim and two counter-rotating energy arcs
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 1.6;
      const spin = shieldPhase * 0.25;
      ctx.beginPath();
      ctx.arc(0, 0, r, spin, spin + 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r, -spin * 1.4 + Math.PI, -spin * 1.4 + Math.PI + 0.6);
      ctx.stroke();

      // Specular highlight
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(-3, -3, r * 0.62, Math.PI * 1.05, Math.PI * 1.45);
      ctx.stroke();

      ctx.restore();
    }
  },

  // -------------------------------------------------------------
  // 9. HD BULLET RENDERING
  // Incendiary tracer shell with glowing plasma core and tail glow
  // -------------------------------------------------------------
  drawBullet(ctx, x, y, dir) {
    ctx.save();

    // Glow aura
    ctx.shadowColor = '#ff9100';
    ctx.shadowBlur = 8;

    if (dir === 'UP' || dir === 'DOWN') {
      const grad = ctx.createLinearGradient(x, y - 4, x, y + 4);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ffea00');
      grad.addColorStop(1, '#ff3d00');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 1.5, y - 3, 3, 7);

      // Plasma tracer core
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 0.75, y - 2, 1.5, 4);
    } else {
      const grad = ctx.createLinearGradient(x - 4, y, x + 4, y);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ffea00');
      grad.addColorStop(1, '#ff3d00');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 3, y - 1.5, 7, 3);

      // Plasma tracer core
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 2, y - 0.75, 4, 1.5);
    }

    ctx.restore();
  },

  // -------------------------------------------------------------
  // 10. CINEMATIC EXPLOSION RENDERING
  // Multi-phase explosion: expanding shockwave ring, blinding white core,
  // swirling fiery orange fireball lobes, billowing smoke, flying sparks
  // -------------------------------------------------------------
  drawExplosion(ctx, x, y, progress, large = false) {
    const maxRadius = large ? 30 : 16;
    const currentR = maxRadius * Math.sin(progress * Math.PI * 0.85);

    ctx.save();

    // 1. Expanding Shockwave Ring (early phase)
    if (progress < 0.6) {
      const waveR = maxRadius * (progress / 0.6) * 1.3;
      ctx.strokeStyle = `rgba(255, 230, 150, ${1 - progress / 0.6})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, waveR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 2. Billowing Dark Smoke Puffs (late phase)
    if (progress > 0.3) {
      const smokeAlpha = (1 - progress) * 0.7;
      ctx.fillStyle = `rgba(30, 32, 40, ${smokeAlpha})`;
      for (let s = 0; s < 5; s++) {
        const sa = (s * Math.PI * 2 / 5) + progress;
        const sDist = currentR * 0.8;
        ctx.beginPath();
        ctx.arc(x + Math.cos(sa) * sDist, y + Math.sin(sa) * sDist, currentR * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. Fiery Orange/Red Flame Petals
    const fireGrad = ctx.createRadialGradient(x, y, 2, x, y, currentR);
    fireGrad.addColorStop(0, '#ffffff');
    fireGrad.addColorStop(0.25, '#ffe600');
    fireGrad.addColorStop(0.65, '#ff3d00');
    fireGrad.addColorStop(1, 'rgba(180, 0, 0, 0)');
    ctx.fillStyle = fireGrad;
    ctx.shadowColor = '#ff6d00';
    ctx.shadowBlur = 12;

    // Multi-lobed fireball
    ctx.beginPath();
    ctx.arc(x, y, currentR, 0, Math.PI * 2);
    ctx.fill();

    for (let lobe = 0; lobe < 4; lobe++) {
      const la = (lobe * Math.PI / 2) + (progress * 2);
      const lx = x + Math.cos(la) * (currentR * 0.4);
      const ly = y + Math.sin(la) * (currentR * 0.4);
      ctx.beginPath();
      ctx.arc(lx, ly, currentR * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. White-Hot Flash Core (during initial burst)
    if (progress < 0.4) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, currentR * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Flying Shrapnel Spark Embers
    if (large) {
      ctx.fillStyle = '#ffe082';
      ctx.shadowColor = '#ffab00';
      ctx.shadowBlur = 6;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI / 4) + (progress * 1.5);
        const dist = maxRadius * (0.8 + progress * 1.2);
        ctx.fillRect(x + Math.cos(a) * dist - 1.5, y + Math.sin(a) * dist - 1.5, 3, 3);
      }
    }

    ctx.restore();
  }
};

Sprites.init();
