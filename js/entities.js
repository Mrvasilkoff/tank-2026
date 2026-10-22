/**
 * TANK 2026 - Game Entities & Physics
 * Precise collision detection, grid-rail snapping, projectile physics, and AI
 */

const DIRS = {
  UP:    { dx: 0,  dy: -1, opp: 'DOWN' },
  RIGHT: { dx: 1,  dy: 0,  opp: 'LEFT' },
  DOWN:  { dx: 0,  dy: 1,  opp: 'UP' },
  LEFT:  { dx: -1, dy: 0,  opp: 'RIGHT' }
};

class Entity {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.dead = false;
  }

  getBounds() {
    return {
      left: this.x,
      right: this.x + this.w,
      top: this.y,
      bottom: this.y + this.h
    };
  }

  collidesWith(other) {
    return (
      this.x < other.x + other.w &&
      this.x + this.w > other.x &&
      this.y < other.y + other.h &&
      this.y + this.h > other.y
    );
  }
}

// -------------------------------------------------------------
// BASE (Phoenix Eagle)
// -------------------------------------------------------------
class BaseEagle extends Entity {
  constructor(x, y) {
    super(x, y, 32, 32);
    this.walls = MapGenerator.fortWallsFor(x / 16, y / 16); // Bunker tiles around this Eagle
    this.alive = true;
    this.hp = 2; // Takes 2 hits before destroyed; first hit triggers alert siren!
    this.shovelTimer = 0; // Timer for fortified steel walls
    this.shovelFlashing = false;
  }

  hit() {
    if (!this.alive) return;
    this.hp--;
    if (this.hp <= 0) {
      this.alive = false;
      sound.playExplosion(true);
    } else {
      sound.playBonusAlert();
    }
  }

  update(dt, map) {
    if (this.shovelTimer > 0) {
      this.shovelTimer -= dt;
      this.shovelFlashing = this.shovelTimer < 4.0; // Flash in last 4 seconds

      if (this.shovelTimer <= 0) {
        // Revert fortified base back to brick
        map.setBaseWalls(MapGenerator.TILES.BRICK, this.walls);
      }
    }
  }

  fortify(duration = 20) {
    this.shovelTimer = duration;
  }
}

// -------------------------------------------------------------
// BULLET
// -------------------------------------------------------------
class Bullet extends Entity {
  constructor(owner, x, y, direction, speed, canBreakSteel = false, shooter = null) {
    super(x, y, 6, 6);
    this.owner = owner; // 'player' or 'enemy'
    this.direction = direction;
    this.speed = speed;
    this.canBreakSteel = canBreakSteel;
    this.shooter = shooter;
  }

  update(dt, map) {
    const dir = DIRS[this.direction];
    this.x += dir.dx * this.speed;
    this.y += dir.dy * this.speed;

    // Boundary check
    if (this.x < 0 || this.x > map.pxW || this.y < 0 || this.y > map.pxH) {
      this.dead = true;
      if (this.owner === 'player') sound.playRicochet('steel');
    }
  }

  render(ctx) {
    Sprites.drawBullet(ctx, this.x + 3, this.y + 3, this.direction);
  }
}

// -------------------------------------------------------------
// TANK BASE CLASS
// -------------------------------------------------------------
class Tank extends Entity {
  constructor(x, y, size = 26) {
    super(x, y, size, size);
    this.direction = 'UP';
    this.desiredDirection = 'UP';
    this.speed = 1.05; // Calibrated 60fps natural tank movement speed
    this.moving = false;
    this.trackAnim = 0;
    this.trackTimer = 0;
    this.trackPos = 0; // Distance driven: drives the scrolling track links
    this.hasBoat = false;
    this.slipping = false;
    this.slipVel = { x: 0, y: 0 };
  }

  // Classic NES Rail-Snapping: turns snap cleanly to 16px/32px corridor centers
  setDirection(newDir, map) {
    this.desiredDirection = newDir;
    if (newDir === this.direction) return;

    const isPerpendicular = (
      (this.direction === 'UP' || this.direction === 'DOWN') && (newDir === 'LEFT' || newDir === 'RIGHT') ||
      (this.direction === 'LEFT' || this.direction === 'RIGHT') && (newDir === 'UP' || newDir === 'DOWN')
    );

    if (isPerpendicular) {
      // Corridors are 32px with 3px margins: 3, 19, 35, 51, 67... (16*k + 3)
      if (newDir === 'LEFT' || newDir === 'RIGHT') {
        const nearestY = Math.round((this.y - 3) / 16) * 16 + 3;
        if (Math.abs(this.y - nearestY) <= 8) {
          if (!map.isBlocked(this.x, nearestY, this.w, this.h, this.hasBoat, this)) {
            this.y = nearestY;
          }
        }
      } else {
        const nearestX = Math.round((this.x - 3) / 16) * 16 + 3;
        if (Math.abs(this.x - nearestX) <= 8) {
          if (!map.isBlocked(nearestX, this.y, this.w, this.h, this.hasBoat, this)) {
            this.x = nearestX;
          }
        }
      }
    }

    this.direction = newDir;
  }

  isFacingBrick(map) {
    const dir = DIRS[this.direction];
    let checkX = this.x + 13 + dir.dx * 16;
    let checkY = this.y + 13 + dir.dy * 16;
    const col = Math.floor(checkX / 16);
    const row = Math.floor(checkY / 16);
    if (col >= 0 && col < map.cols && row >= 0 && row < map.rows) {
      return map.grid[row][col] === MapGenerator.TILES.BRICK;
    }
    return false;
  }

  moveInDirection(dirName, map, deltaSpeed = null) {
    const spd = deltaSpeed !== null ? deltaSpeed : this.speed;
    const dir = DIRS[dirName];
    const newX = this.x + dir.dx * spd;
    const newY = this.y + dir.dy * spd;

    // Check bounds
    if (newX < 0 || newX + this.w > map.pxW || newY < 0 || newY + this.h > map.pxH) {
      return false;
    }

    // Check map tile collisions & tank collisions
    if (map.isBlocked(newX, newY, this.w, this.h, this.hasBoat, this)) {
      // ARCADE CORNER-SLIDING ASSISTANCE:
      // When approaching a corridor, if offset from the rail center by 1-6px,
      // slide laterally to align into the open lane!
      if (dirName === 'UP' || dirName === 'DOWN') {
        const railX = Math.round((this.x - 3) / 16) * 16 + 3;
        const diffX = railX - this.x;
        if (Math.abs(diffX) > 0.05 && Math.abs(diffX) <= 6) {
          const stepX = Math.sign(diffX) * Math.min(Math.abs(diffX), spd);
          const tryX = this.x + stepX;
          if (!map.isBlocked(tryX, this.y, this.w, this.h, this.hasBoat, this)) {
            this.x = tryX;
            if (!map.isBlocked(this.x, newY, this.w, this.h, this.hasBoat, this)) {
              this.y = newY;
              this.moving = true;
              return true;
            }
          }
        }
      } else if (dirName === 'LEFT' || dirName === 'RIGHT') {
        const railY = Math.round((this.y - 3) / 16) * 16 + 3;
        const diffY = railY - this.y;
        if (Math.abs(diffY) > 0.05 && Math.abs(diffY) <= 6) {
          const stepY = Math.sign(diffY) * Math.min(Math.abs(diffY), spd);
          const tryY = this.y + stepY;
          if (!map.isBlocked(this.x, tryY, this.w, this.h, this.hasBoat, this)) {
            this.y = tryY;
            if (!map.isBlocked(newX, this.y, this.w, this.h, this.hasBoat, this)) {
              this.x = newX;
              this.moving = true;
              return true;
            }
          }
        }
      }
      return false;
    }

    this.x = newX;
    this.y = newY;
    this.moving = true;

    // Tread animation
    this.trackPos = (this.trackPos + spd) % 600;
    this.trackTimer += spd;
    if (this.trackTimer >= 4) {
      this.trackAnim = 1 - this.trackAnim;
      this.trackTimer = 0;
    }

    // Check if on ice
    if (map.isOnIce(this.x + this.w / 2, this.y + this.h / 2)) {
      this.slipping = true;
      this.slipVel = { x: dir.dx * spd * 0.8, y: dir.dy * spd * 0.8 };
    } else {
      this.slipping = false;
    }

    return true;
  }

  handleIceDrift(map) {
    if (!this.slipping) return;
    const newX = this.x + this.slipVel.x;
    const newY = this.y + this.slipVel.y;
    if (newX >= 0 && newX + this.w <= map.pxW && newY >= 0 && newY + this.h <= map.pxH) {
      if (!map.isBlocked(newX, newY, this.w, this.h, this.hasBoat, this)) {
        this.x = newX;
        this.y = newY;
      } else {
        this.slipping = false;
      }
    } else {
      this.slipping = false;
    }
    this.slipVel.x *= 0.92;
    this.slipVel.y *= 0.92;
    if (Math.abs(this.slipVel.x) < 0.1 && Math.abs(this.slipVel.y) < 0.1) {
      this.slipping = false;
    }
  }
}

// -------------------------------------------------------------
// PLAYER TANK
// -------------------------------------------------------------
class PlayerTank extends Tank {
  constructor(x, y, index = 0) {
    super(x, y, 26);
    this.type = 'player';
    this.index = index; // 0: Player I, 1: Player II
    this.frozenTimer = 0; // Paralysis (friendly fire or enemy Clock bonus)
    this.respawnTimer = 0;
    this.kills = { basic: 0, fast: 0, power: 0, armor: 0 };
    this.tier = 1; // 1: 0 Stars (Basic), 2: 1 Star (Light/Fast), 3: 2 Stars (Twin Rapid), 4: 3 Stars (Heavy Steel Destroyer)
    this.lives = 3;
    this.score = 0;
    this.activeBullets = 0;
    this.maxBullets = 1;
    this.bulletSpeed = 3.2;
    this.shieldTimer = 3.5; // Shield on spawn
    this.shieldPhase = 0;
    this.speed = 1.05; // Deliberate responsive authentic speed
    this.spawnX = x;
    this.spawnY = y;
    this.canBreakTrees = false;
    this.recoil = 0;
    this.muzzleFlash = 0;
    this.lastBarrelSide = -1; // For alternating twin cannon fire (-1: left, 1: right)
    this.upgradeTier(1);
  }

  resetKills() {
    this.kills = { basic: 0, fast: 0, power: 0, armor: 0 };
  }

  upgradeTier(toTier = null) {
    if (toTier !== null) {
      this.tier = Math.min(4, toTier);
    } else {
      this.tier = Math.min(4, this.tier + 1);
    }

    // Authentic Battle City / Tank 1990 Tier Attributes (calibrated for 60 FPS)
    // Tier 1 (0 Stars): Basic cannon, 1 bullet on screen, standard bullet speed
    // Tier 2 (1 Star): Fast cannon shell, 1 bullet on screen, high velocity
    // Tier 3 (2 Stars): Twin rapid-fire cannons, 2 bullets on screen, high velocity
    // Tier 4 (3 Stars): Heavy siege destroyer, 2 high-velocity bullets, breaks steel & clears trees!
    // Player shells always outrun enemy shells (fastest enemy: 5.0, boosted cap 5.5),
    // so the player wins a head-on duel when firing first
    if (this.tier === 1) {
      this.speed = 1.05;
      this.bulletSpeed = 5.8;
      this.maxBullets = 1;
      this.canBreakTrees = false;
    } else if (this.tier === 2) {
      this.speed = 1.15;
      this.bulletSpeed = 6.3; // High-velocity shell
      this.maxBullets = 1;
      this.canBreakTrees = false;
    } else if (this.tier === 3) {
      this.speed = 1.25;
      this.bulletSpeed = 6.6; // Rapid twin firing
      this.maxBullets = 2;
      this.canBreakTrees = false;
    } else if (this.tier === 4) {
      this.speed = 1.35;
      this.bulletSpeed = 7.0; // High-power siege shells
      this.maxBullets = 2;
      this.canBreakTrees = true; // Demolishes steel barriers & mows down trees
    }
    if (this.upgradeHook) this.upgradeHook(this); // Conquest upgrades on top of the tier
  }

  // keepUpgrades: next stage (weapon stars and boat stay); otherwise a respawn after death
  respawn(keepUpgrades = false) {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.direction = 'UP';
    this.desiredDirection = 'UP';
    this.shieldTimer = 3.5;
    if (!keepUpgrades) this.hasBoat = false;
    this.slipping = false;
    this.activeBullets = 0;
    this.dead = false;
    this.recoil = 0;
    this.muzzleFlash = 0;
    this.frozenTimer = 0;
    this.respawnTimer = 0;
    this.upgradeTier(keepUpgrades ? this.tier : 1);
  }

  shoot() {
    if (this.activeBullets >= this.maxBullets || this.dead) return null;

    const dir = DIRS[this.direction];
    let bx = this.x + 10 + dir.dx * 14;
    let by = this.y + 10 + dir.dy * 14;

    // Twin cannon alternating barrel offset (for Tier 3 and 4)
    if (this.tier >= 3) {
      this.lastBarrelSide = -this.lastBarrelSide;
      const perpX = -dir.dy;
      const perpY = dir.dx;
      bx += perpX * (this.lastBarrelSide * 3.5);
      by += perpY * (this.lastBarrelSide * 3.5);
    }

    this.activeBullets++;
    this.recoil = 2.5; // Visual recoil kickback
    this.muzzleFlash = 0.08; // Bright fiery muzzle flash at barrel tip
    sound.playShoot(this.tier);

    const canBreakSteel = (this.tier >= 4);
    return new Bullet('player', bx, by, this.direction, this.bulletSpeed, canBreakSteel, this);
  }

  update(dt, map) {
    this.shieldPhase += dt * 10;
    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
    }
    if (this.frozenTimer > 0) {
      this.frozenTimer -= dt;
    }
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 25);
    }
    if (this.muzzleFlash > 0) {
      this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    }
    this.handleIceDrift(map);
  }

  render(ctx) {
    if (this.dead) return;
    // Paralysed tanks blink
    if (this.frozenTimer > 0 && Math.floor(Date.now() / 120) % 2 === 0) return;
    Sprites.drawTank(ctx, this.x - 1, this.y - 1, {
      type: 'player',
      playerIndex: this.index,
      tier: this.tier,
      direction: this.direction,
      trackAnim: this.trackAnim,
      trackPos: this.trackPos,
      hasShield: this.shieldTimer > 0,
      hasBoat: this.hasBoat,
      shieldPhase: this.shieldPhase,
      recoil: this.recoil,
      muzzleFlash: this.muzzleFlash > 0,
      barrelSide: this.lastBarrelSide
    });
  }
}

// -------------------------------------------------------------
// ENEMY TANK (Authentic NES Battle City AI & Distinct Profiles)
// -------------------------------------------------------------
class EnemyTank extends Tank {
  constructor(x, y, config) {
    super(x, y, 26);
    this.type = config.type; // 'basic', 'fast', 'power', 'armor'
    this.hp = config.hp;
    this.points = config.points;
    this.isFlashing = config.isFlashing;
    this.direction = 'DOWN';
    this.desiredDirection = 'DOWN';
    this.activeBullets = 0;
    this.turnCooldown = 0;
    this.blockedTimer = 0;
    this.recoil = 0;
    this.muzzleFlash = 0;
    this.stunTimer = 0; // Hit stun / flinch
    this.lastIntersectionCheck = { x: -1, y: -1 };

    // Setup authentic attributes per type (calibrated for 60 FPS)
    // 1. Basic Tank: Infantry line, moderate speed, standard shot
    // 2. Fast Tank: Rapid scout, agile corridor runner, aggressive base rusher!
    // 3. Power Tank: Sniper tank with lightning-fast velocity shells
    // 4. Armor Tank: Heavy juggernaut dreadnought, 4 HP with armor damage color phases
    if (this.type === 'basic') {
      this.speed = 0.82;
      this.bulletSpeed = 2.8;
      this.maxBullets = 1;
      this.changeDirTimer = 1.5 + Math.random() * 2.0;
      this.shootTimer = 0.7 + Math.random() * 1.2;
    } else if (this.type === 'fast') {
      this.speed = 1.35; // Very fast, outruns standard player tank
      this.bulletSpeed = 3.2;
      this.maxBullets = 1;
      this.changeDirTimer = 1.0 + Math.random() * 1.5;
      this.shootTimer = 0.5 + Math.random() * 1.0;
    } else if (this.type === 'power') {
      this.speed = 0.90;
      this.bulletSpeed = 5.0; // High-velocity sniper shell, rips through brick
      this.maxBullets = 2;
      this.changeDirTimer = 1.5 + Math.random() * 2.0;
      this.shootTimer = 0.4 + Math.random() * 0.8;
    } else if (this.type === 'armor') {
      this.speed = 0.75; // Heavy dreadnought
      this.bulletSpeed = 3.0;
      this.maxBullets = 1;
      this.changeDirTimer = 2.0 + Math.random() * 2.0;
      this.shootTimer = 0.8 + Math.random() * 1.2;
    } else if (this.type === 'artillery') {
      // Conquest: slow mortar carrier, lobs shells over walls (see Game.updateSpecialEnemies)
      this.speed = 0.6;
      this.bulletSpeed = 2.6;
      this.maxBullets = 1;
      this.changeDirTimer = 2.5 + Math.random() * 2.0;
      this.shootTimer = 1.5 + Math.random() * 1.5;
    } else if (this.type === 'miner') {
      // Conquest: lays mines behind itself
      this.speed = 1.15;
      this.bulletSpeed = 3.0;
      this.maxBullets = 1;
      this.changeDirTimer = 1.2 + Math.random() * 1.5;
      this.shootTimer = 1.0 + Math.random() * 1.2;
    } else if (this.type === 'scout') {
      // Conquest: very fast, calls reinforcements when it spots a player
      this.speed = 1.55;
      this.bulletSpeed = 3.4;
      this.maxBullets = 1;
      this.changeDirTimer = 0.8 + Math.random() * 1.0;
      this.shootTimer = 0.9 + Math.random() * 1.0;
    } else if (this.type === 'boss') {
      // Fortress boss: twice the size, twin cannons and an all-round salvo
      this.isBoss = true;
      this.w = 52;
      this.h = 52;
      this.speed = 0.55;
      this.bulletSpeed = 4.2;
      this.maxBullets = 6;
      this.changeDirTimer = 2.0;
      this.shootTimer = 1.0;
      this.salvoTimer = 5;
      this.maxHp = this.hp;
    }
  }

  update(dt, map, player, base, isFrozen = false) {
    if (this.dead) return null;

    if (isFrozen) {
      // Frozen by Clock bonus
      this.moving = false;
      return null;
    }

    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      this.moving = false;
      return null;
    }

    // Deadlock breaker: an enemy that has not moved for over a second (e.g. two tanks
    // nose to nose in a dead end) may drive through other enemy tanks for a while
    if (this.ghostTimer > 0) {
      this.ghostTimer -= dt;
      // Do not become solid again while still inside another enemy
      if (this.ghostTimer <= 0 && map.game && map.game.enemies.some(o => o !== this && !o.dead && this.collidesWith(o))) {
        this.ghostTimer = 0.2;
      }
    }
    const movedBy = Math.abs(this.x - (this.lastX ?? this.x)) + Math.abs(this.y - (this.lastY ?? this.y));
    this.lastX = this.x;
    this.lastY = this.y;
    this.stillTimer = movedBy < 0.05 ? (this.stillTimer || 0) + dt : 0;
    if (this.stillTimer > 1.2) {
      this.stillTimer = 0;
      this.ghostTimer = 1.5;
      this.pickNewDirection(map, player, base, true);
    }

    this.turnCooldown -= dt;
    this.changeDirTimer -= dt;
    this.shootTimer -= dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 25);
    if (this.muzzleFlash > 0) this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);

    // 1. Tactical Human-Fair Line of Sight Shooting (Fair 380-600ms reaction window!)
    // Player can outdraw and shoot first when going head-to-head!
    if (player && !player.dead) {
      const xDiff = Math.abs((this.x + 13) - (player.x + 13));
      const yDiff = Math.abs((this.y + 13) - (player.y + 13));
      if (xDiff < 14) {
        if ((this.direction === 'DOWN' && this.y < player.y) ||
            (this.direction === 'UP' && this.y > player.y)) {
          this.shootTimer = Math.min(this.shootTimer, (0.38 + Math.random() * 0.22) * (this.reaction || 1));
        }
      } else if (yDiff < 14) {
        if ((this.direction === 'RIGHT' && this.x < player.x) ||
            (this.direction === 'LEFT' && this.x > player.x)) {
          this.shootTimer = Math.min(this.shootTimer, (0.38 + Math.random() * 0.22) * (this.reaction || 1));
        }
      }
    }

    // 2. Eagle Base Homing / Targeting
    // If facing the Phoenix Eagle base and lined up, open fire with zero hesitation!
    if (base && base.alive) {
      const baseXDiff = Math.abs((this.x + 13) - (base.x + 16));
      if (baseXDiff < 18 && this.direction === 'DOWN' && this.y < base.y) {
        this.shootTimer = Math.min(this.shootTimer, 0.08);
      }
    }

    // 3. Corridor Intersection Decision Points (Authentic NES AI)
    // When crossing a 16px corridor intersection, evaluate turning into open lanes!
    const atRailX = Math.abs(((this.x - 3) % 16)) < 1.0;
    const atRailY = Math.abs(((this.y - 3) % 16)) < 1.0;
    const currentGridX = Math.round((this.x - 3) / 16);
    const currentGridY = Math.round((this.y - 3) / 16);

    if (atRailX && atRailY && this.turnCooldown <= 0) {
      if (this.lastIntersectionCheck.x !== currentGridX || this.lastIntersectionCheck.y !== currentGridY) {
        this.lastIntersectionCheck = { x: currentGridX, y: currentGridY };

        // Turn evaluation probability per type
        // Fast tanks evaluate turns frequently (35%), basic (22%), power (25%), armor (20%)
        const turnChance = this.type === 'fast' ? 0.35 : (this.type === 'power' ? 0.25 : 0.20);
        if (Math.random() < turnChance) {
          this.pickNewDirection(map, player, base, false);
          this.turnCooldown = 0.25;
        }
      }
    }

    // 4. Movement Execution
    const moved = this.moveInDirection(this.direction, map);
    if (!moved) {
      this.blockedTimer += dt;

      // If facing destructible brick, blast it immediately to punch through!
      if (this.isFacingBrick(map)) {
        this.shootTimer = Math.min(this.shootTimer, 0.06);
      }

      // Fast reaction to obstacles: turn promptly if blocked for > 0.12s
      if (this.blockedTimer > 0.12 && this.turnCooldown <= 0) {
        this.pickNewDirection(map, player, base, true);
        this.blockedTimer = 0;
        this.turnCooldown = 0.20;
      }
    } else {
      this.blockedTimer = 0;
    }

    // Periodic redirection timer
    if (this.changeDirTimer <= 0 && this.turnCooldown <= 0) {
      this.pickNewDirection(map, player, base, false);
      this.changeDirTimer = 1.5 + Math.random() * 2.2;
      this.turnCooldown = 0.25;
    }

    this.handleIceDrift(map);

    // Boss: every few seconds a salvo in all four directions
    if (this.isBoss) {
      this.salvoTimer -= dt;
      if (this.salvoTimer <= 0 && this.activeBullets <= this.maxBullets - 4) {
        this.salvoTimer = (5 + Math.random() * 2) * (this.reaction || 1);
        const cx = this.x + this.w / 2;
        const cy = this.y + this.h / 2;
        this.recoil = 2.5;
        return ['UP', 'DOWN', 'LEFT', 'RIGHT'].map(d => {
          this.activeBullets++;
          return new Bullet('enemy', cx - 3 + DIRS[d].dx * 30, cy - 3 + DIRS[d].dy * 30, d, this.bulletSpeed, false, this);
        });
      }
    }

    // AI Shell Firing (authentic deliberate cadence)
    let bullet = null;
    if (this.shootTimer <= 0) {
      bullet = this.shoot();
      const baseDelay = (this.type === 'power' ? 0.6 : (this.type === 'fast' ? 0.8 : 1.2));
      this.shootTimer = (baseDelay + Math.random() * 1.0) * (this.reaction || 1); // reaction: difficulty
    }

    return bullet;
  }

  pickNewDirection(map, player, base, forceTurn = false) {
    const opp = DIRS[this.direction].opp;
    const allDirs = ['DOWN', 'LEFT', 'RIGHT', 'UP'];

    // Identify which directions are actually unblocked when snapped to rail
    const openDirs = allDirs.filter(d => {
      if (forceTurn && d === this.direction) return false;
      const vec = DIRS[d];
      let testX = this.x;
      let testY = this.y;
      if (d === 'LEFT' || d === 'RIGHT') {
        testY = Math.round((this.y - 3) / 16) * 16 + 3;
        testX = this.x + vec.dx * 8;
      } else {
        testX = Math.round((this.x - 3) / 16) * 16 + 3;
        testY = this.y + vec.dy * 8;
      }
      return !map.isBlocked(testX, testY, this.w, this.h, this.hasBoat, this);
    });

    const candidates = openDirs.length > 0 ? openDirs : (forceTurn ? allDirs.filter(d => d !== this.direction) : allDirs);

    // Tactical AI Direction Weights (Tank 1990 Authentic)
    const weights = {};
    // City guards (conquest): stay inside their city, rush back to the HQ, hunt intruders
    if (this.guard) {
      const g = this.guard;
      const cx = this.x + 13;
      const cy = this.y + 13;
      const inside = cx > g.x - 8 && cx < g.x + g.w + 8 && cy > g.y - 8 && cy < g.y + g.h + 8;
      const intruder = player && !player.dead &&
        player.x + 13 > g.x - 64 && player.x + 13 < g.x + g.w + 64 && player.y + 13 > g.y - 64 && player.y + 13 < g.y + g.h + 64;
      const tx = !inside ? g.cx : intruder ? player.x + 13 : g.cx + (Math.random() - 0.5) * g.w;
      const ty = !inside ? g.cy : intruder ? player.y + 13 : g.cy + (Math.random() - 0.5) * g.h;
      candidates.forEach(d => {
        weights[d] = 10;
        if (d === 'RIGHT' && tx > cx + 6) weights[d] += 45;
        if (d === 'LEFT' && tx < cx - 6) weights[d] += 45;
        if (d === 'DOWN' && ty > cy + 6) weights[d] += 45;
        if (d === 'UP' && ty < cy - 6) weights[d] += 45;
      });
    } else candidates.forEach(d => {
      weights[d] = 20;

      // Authentic NES bias: Enemies naturally flow downwards toward the Base & Player
      if (d === 'DOWN') weights[d] += 40;
      if (d === opp && !forceTurn) weights[d] = Math.max(5, weights[d] - 15);

      // Fast Tank: Extreme Eagle Hunter! Heavily prioritizes rushing down to the Base
      if (this.type === 'fast') {
        if (d === 'DOWN') weights[d] += 35;
        if (base && base.alive) {
          if (d === 'RIGHT' && this.x < base.x - 6) weights[d] += 30;
          if (d === 'LEFT' && this.x > base.x + 6) weights[d] += 30;
        }
      }

      // Base targeting weights for all tanks
      if (base && base.alive) {
        if (d === 'DOWN' && this.y < base.y) weights[d] += 25;
        if (d === 'RIGHT' && this.x < base.x - 12) weights[d] += 15;
        if (d === 'LEFT' && this.x > base.x + 12) weights[d] += 15;
      }

      // Player targeting weights
      if (player && !player.dead) {
        if (d === 'DOWN' && this.y < player.y) weights[d] += 15;
        if (d === 'UP' && this.y > player.y + 80) weights[d] += 8;
        if (d === 'RIGHT' && this.x < player.x) weights[d] += 10;
        if (d === 'LEFT' && this.x > player.x) weights[d] += 10;
      }
    });

    let totalWeight = 0;
    candidates.forEach(d => totalWeight += weights[d]);
    let rand = Math.random() * totalWeight;

    let chosen = candidates[0];
    for (const d of candidates) {
      if (rand < weights[d]) {
        chosen = d;
        break;
      }
      rand -= weights[d];
    }

    this.setDirection(chosen, map);
  }

  shoot() {
    if (this.activeBullets >= this.maxBullets || this.dead) return null;

    const dir = DIRS[this.direction];
    if (this.isBoss) {
      // Twin cannons side by side
      if (this.activeBullets > this.maxBullets - 2) return null;
      const cx = this.x + this.w / 2;
      const cy = this.y + this.h / 2;
      this.recoil = 2.5;
      this.muzzleFlash = 0.08;
      return [-7, 7].map(side => {
        this.activeBullets++;
        return new Bullet('enemy', cx - 3 + dir.dx * 30 - dir.dy * side, cy - 3 + dir.dy * 30 + dir.dx * side,
          this.direction, this.bulletSpeed, false, this);
      });
    }
    let bx = this.x + 10 + dir.dx * 14;
    let by = this.y + 10 + dir.dy * 14;

    this.activeBullets++;
    this.recoil = 2.0;
    this.muzzleFlash = 0.06;
    return new Bullet('enemy', bx, by, this.direction, this.bulletSpeed, false, this);
  }

  takeDamage() {
    this.hp--;
    this.stunTimer = this.isBoss ? 0.04 : 0.22; // Hit flinch / stun prevents instant counter-fire!
    this.recoil = 2.5;
    if (this.hp <= 0) {
      this.dead = true;
      return true; // Destroyed
    }
    sound.playRicochet('armor');
    return false; // Still alive, armor weakened
  }

  render(ctx) {
    if (this.dead) return;
    ctx.save();
    if (this.ghostTimer > 0) ctx.globalAlpha *= 0.7; // Passing through another tank
    if (this.isBoss) {
      // Same tank drawing at double size
      ctx.translate(this.x, this.y);
      ctx.scale(2, 2);
      Sprites.drawTank(ctx, -1, -1, {
        type: 'boss', direction: this.direction, trackAnim: this.trackAnim, trackPos: this.trackPos,
        armorHp: 4, hasBoat: this.hasBoat, recoil: this.recoil, muzzleFlash: this.muzzleFlash > 0
      });
      ctx.restore();
      return;
    }
    Sprites.drawTank(ctx, this.x - 1, this.y - 1, {
      type: this.type,
      direction: this.direction,
      trackAnim: this.trackAnim,
      trackPos: this.trackPos,
      isFlashing: this.isFlashing,
      armorHp: this.hp,
      hasBoat: this.hasBoat,
      recoil: this.recoil,
      muzzleFlash: this.muzzleFlash > 0
    });
    // Marks of the conquest-only types
    const cx = this.x + 13;
    const cy = this.y + 13;
    if (this.type === 'artillery') {
      ctx.fillStyle = '#20240f';
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c9d77a';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (this.type === 'miner') {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i % 2 ? '#15171a' : '#ffd54f';
        ctx.fillRect(cx - 4.5 + i * 3, cy - 1.5, 3, 3);
      }
    } else if (this.type === 'scout') {
      ctx.strokeStyle = '#f3e6c0';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx + 5, cy + 5);
      ctx.lineTo(cx + 11, cy - 9);
      ctx.stroke();
      ctx.fillStyle = '#ff5252';
      ctx.fillRect(cx + 10.3, cy - 10, 1.6, 1.6);
    }
    ctx.restore();
  }
}

// -------------------------------------------------------------
// POWER-UP ENTITY
// -------------------------------------------------------------
class PowerUpItem extends Entity {
  constructor(x, y, type) {
    super(x, y, 28, 28);
    this.type = type; // star, helmet, clock, shovel, grenade, tank, gun, boat
    this.life = 25.0; // Disappears after 25s if uncollected
    this.blinkTimer = 0;
  }

  update(dt) {
    this.life -= dt;
    this.blinkTimer += dt;
    if (this.life <= 0) this.dead = true;
  }

  render(ctx) {
    if (this.dead) return;
    // Fast blink when about to disappear
    if (this.life < 5.0 && Math.floor(this.blinkTimer * 8) % 2 === 0) {
      return;
    }
    const sprite = Sprites.cache['bonus_' + this.type];
    if (sprite) {
      const bob = Math.sin(this.blinkTimer * 4) * 1.5;
      // Pop-in with overshoot during the first 0.3s
      const t = Math.min(1, this.blinkTimer / 0.3);
      const pop = t < 1 ? 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2) : 1;
      const cx = this.x + 14;
      const cy = this.y + 14 + bob;

      ctx.save();
      const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 20);
      glow.addColorStop(0, `rgba(255, 230, 120, ${0.28 + Math.sin(this.blinkTimer * 6) * 0.12})`);
      glow.addColorStop(1, 'rgba(255, 230, 120, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fill();

      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      ctx.drawImage(sprite, 0, 0, 60, 60, -14, -14, 28, 28);
      ctx.restore();
    }
  }
}

// -------------------------------------------------------------
// VISUAL EFFECTS: Explosions & Floating Points
// -------------------------------------------------------------
class ExplosionEffect {
  constructor(x, y, large = false) {
    this.x = x;
    this.y = y;
    this.large = large;
    this.duration = large ? 0.45 : 0.25;
    this.timer = 0;
    this.dead = false;
  }

  update(dt) {
    this.timer += dt;
    if (this.timer >= this.duration) {
      this.dead = true;
    }
  }

  render(ctx) {
    const progress = this.timer / this.duration;
    Sprites.drawExplosion(ctx, this.x, this.y, progress, this.large);
  }
}

class FloatingScore {
  constructor(x, y, score, opts = {}) {
    this.x = x;
    this.y = y;
    this.score = score;
    this.text = opts.text || ('+' + score);
    this.color = opts.color || '#ffffff';
    this.rise = opts.rise !== undefined ? opts.rise : 25;
    this.duration = opts.duration || 0.8;
    this.timer = 0;
    this.dead = false;
  }

  update(dt) {
    this.timer += dt;
    this.y -= dt * this.rise; // Drifts upward
    if (this.timer >= this.duration) this.dead = true;
  }

  render(ctx) {
    const pop = 1 + 0.5 * Math.max(0, 1 - this.timer / 0.15);
    const fade = Math.min(1, (this.duration - this.timer) / (this.duration * 0.3));
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade);
    ctx.translate(this.x, this.y);
    ctx.scale(pop, pop);
    ctx.font = '9px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = this.color;
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 4;
    ctx.fillText(this.text, 0, 0);
    ctx.restore();
  }
}
