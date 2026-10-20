import { ENEMY_MAX_HP, ENEMY_RADIUS, TILE } from '../shared/constants.js';
import { isSolid, lineOfSight, roomOf } from '../shared/map.js';
import { PLAYER_HALF, moveBody } from '../shared/physics.js';

const SPAWN_INTERVAL = 5; // seconds between spawns, on average, across the whole map
const MAX_ENEMIES = 30;
const CHASE_SPEED = 3.5; // tiles per second; players move at 5
const WANDER_SPEED = 1.2;
const WANDER_DISTANCE = [1.5, 4]; // tiles
const IDLE_TIME = [1, 3]; // seconds between wanders
const STUCK_TIME = 0.5; // give up on a goal after this long without progress
const TOUCH_SLACK = 0.05; // how close counts as touching a player

// Enemies live only on the server. Each one is
//   { id, x, y, hp, mode, goal, wait, stuck }
// where mode is:
//   'idle'   standing still for `wait` seconds, or wandering to `goal`
//   'chase'  moving straight at the nearest player it can see
//   'search' lost sight of its target; heading to where it was last seen
// Enemies can't open doors, and closed doors block both movement and sight.
export class Enemies {
  constructor(map, rng) {
    this.map = map;
    this.rng = rng;
    this.list = [];
    this.nextId = 1;
    // Per room, the floor tiles an enemy can appear on.
    this.spawnTiles = map.rooms.map(() => []);
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.roomAt[i] >= 0 && map.tiles[i] === TILE.FLOOR) this.spawnTiles[map.roomAt[i]].push(i);
    }
  }

  // Advances spawning and movement by `dt` seconds. `players` are bodies
  // ({ x, y, down }); downed players are ignored as targets.
  update(players, dt) {
    this.maybeSpawn(players, dt);
    const targets = players.filter((p) => !p.down);
    for (const enemy of this.list) this.think(enemy, targets, dt);
    this.separate();
  }

  // Number of enemies touching the player.
  touching(player) {
    return this.list.filter((enemy) => touches(enemy, player)).length;
  }

  // Whether any enemy overlaps the rect (used to stop doors closing on one).
  anyOverlapping(rect) {
    return this.list.some((e) =>
      e.x + ENEMY_RADIUS > rect.x &&
      e.x - ENEMY_RADIUS < rect.x + rect.w &&
      e.y + ENEMY_RADIUS > rect.y &&
      e.y - ENEMY_RADIUS < rect.y + rect.h);
  }

  // The first enemy a ray from (x, y) along unit direction (dx, dy) hits within
  // `maxDist`, as { enemy, dist }, or null.
  firstHit(x, y, dx, dy, maxDist) {
    let best = null;
    for (const enemy of this.list) {
      // Ray-circle intersection: solve |p + d*t - c| = r for the nearest t >= 0.
      const fx = x - enemy.x;
      const fy = y - enemy.y;
      const b = fx * dx + fy * dy;
      const c = fx * fx + fy * fy - ENEMY_RADIUS * ENEMY_RADIUS;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = c <= 0 ? 0 : -b - Math.sqrt(disc); // c <= 0: the ray starts inside it
      if (t >= 0 && t <= maxDist && (!best || t < best.dist)) best = { enemy, dist: t };
    }
    return best;
  }

  // Takes HP from an enemy, removing it at 0.
  damage(enemy, amount) {
    enemy.hp -= amount;
    if (enemy.hp <= 0) this.list = this.list.filter((e) => e !== enemy);
  }

  positions() {
    return this.list.map(({ id, x, y, hp }) => ({ id, x: round(x), y: round(y), hp }));
  }

  // On average one spawn per SPAWN_INTERVAL, in a random room with no player in it.
  maybeSpawn(players, dt) {
    if (this.list.length >= MAX_ENEMIES) return;
    if (this.rng.next() >= dt / SPAWN_INTERVAL) return;

    const occupied = new Set(players.map((p) => roomOf(this.map, p.x, p.y)));
    const free = this.map.rooms.filter((room) => !occupied.has(room.id));
    if (!free.length) return;
    const tile = this.rng.pick(this.spawnTiles[this.rng.pick(free).id]);
    this.list.push({
      id: this.nextId++,
      x: (tile % this.map.width) + 0.5,
      y: Math.floor(tile / this.map.width) + 0.5,
      hp: ENEMY_MAX_HP,
      mode: 'idle',
      goal: null,
      wait: this.randomBetween(IDLE_TIME),
      stuck: 0,
    });
  }

  think(enemy, targets, dt) {
    const target = this.nearestVisible(enemy, targets);
    if (target) {
      enemy.mode = 'chase';
      enemy.goal = { x: target.x, y: target.y };
      if (!touches(enemy, target)) this.moveToward(enemy, enemy.goal, CHASE_SPEED, dt);
      return;
    }

    if (enemy.mode === 'chase') {
      enemy.mode = 'search';
      enemy.stuck = 0;
    }
    if (enemy.mode === 'search') {
      if (this.moveToward(enemy, enemy.goal, CHASE_SPEED, dt)) this.rest(enemy);
      return;
    }

    if (enemy.goal) {
      if (this.moveToward(enemy, enemy.goal, WANDER_SPEED, dt)) this.rest(enemy);
    } else if ((enemy.wait -= dt) <= 0) {
      enemy.goal = this.wanderGoal(enemy);
      if (!enemy.goal) enemy.wait = this.randomBetween(IDLE_TIME);
    }
  }

  nearestVisible(enemy, targets) {
    let best = null;
    let bestDist = Infinity;
    for (const target of targets) {
      const dist = Math.hypot(target.x - enemy.x, target.y - enemy.y);
      if (dist < bestDist && lineOfSight(this.map, enemy.x, enemy.y, target.x, target.y)) {
        best = target;
        bestDist = dist;
      }
    }
    return best;
  }

  // Moves toward `goal` at `speed` for `dt` seconds. Returns true once the goal
  // is reached, or when the enemy has been blocked for a while (so it gives up).
  moveToward(enemy, goal, speed, dt) {
    const dx = goal.x - enemy.x;
    const dy = goal.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05) return true;

    const step = Math.min(speed * dt, dist);
    const before = { x: enemy.x, y: enemy.y };
    moveBody(enemy, (dx / dist) * step, (dy / dist) * step, ENEMY_RADIUS, this.map);
    const moved = Math.hypot(enemy.x - before.x, enemy.y - before.y);

    enemy.stuck = moved < step * 0.25 ? enemy.stuck + dt : 0;
    return enemy.stuck > STUCK_TIME;
  }

  rest(enemy) {
    enemy.mode = 'idle';
    enemy.goal = null;
    enemy.stuck = 0;
    enemy.wait = this.randomBetween(IDLE_TIME);
  }

  // A random nearby point the enemy can see, or null if none was found.
  wanderGoal(enemy) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const angle = this.rng.next() * Math.PI * 2;
      const dist = this.randomBetween(WANDER_DISTANCE);
      const x = enemy.x + Math.cos(angle) * dist;
      const y = enemy.y + Math.sin(angle) * dist;
      if (!isSolid(this.map, Math.floor(x), Math.floor(y)) && lineOfSight(this.map, enemy.x, enemy.y, x, y)) {
        return { x, y };
      }
    }
    return null;
  }

  // Pushes overlapping enemies apart so they don't merge into one circle.
  separate() {
    const minDist = ENEMY_RADIUS * 2;
    for (let i = 0; i < this.list.length; i++) {
      for (let j = i + 1; j < this.list.length; j++) {
        const a = this.list[i];
        const b = this.list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        // Resolve half the overlap per tick (a quarter each) so crowds settle smoothly.
        const push = (minDist - dist) / 4;
        const nx = dist > 1e-6 ? (dx / dist) * push : push;
        const ny = dist > 1e-6 ? (dy / dist) * push : 0;
        moveBody(a, -nx, -ny, ENEMY_RADIUS, this.map);
        moveBody(b, nx, ny, ENEMY_RADIUS, this.map);
      }
    }
  }

  randomBetween([min, max]) {
    return min + this.rng.next() * (max - min);
  }
}

// Circle (enemy) against square (player) contact, with a little slack so an
// enemy that stops at the player's edge still counts as touching.
function touches(enemy, player) {
  const dx = Math.max(Math.abs(enemy.x - player.x) - PLAYER_HALF, 0);
  const dy = Math.max(Math.abs(enemy.y - player.y) - PLAYER_HALF, 0);
  return Math.hypot(dx, dy) <= ENEMY_RADIUS + TOUCH_SLACK;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
