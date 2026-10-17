import {
  AMMO_PICKUP, BULLET_RANGE, BULLET_SPEED, KEY, KEY_MASK, PLAYER_MAX_AMMO, PLAYER_MAX_HP, PLAYER_START_AMMO,
  SIM_STEP, TICK_RATE,
} from '../shared/constants.js';
import { interactionTarget, pointInRect } from '../shared/interact.js';
import { castRay, roomCenter, serializeMap } from '../shared/map.js';
import { bodyOverlapsRect, stepPlayer } from '../shared/physics.js';
import { Enemies } from './enemies.js';
import { generateMap } from './mapgen.js';
import { send } from './net.js';
import { createRng } from './rng.js';

const MAX_QUEUED_INPUTS = 120;
// Seconds of movement a player can bank while idle or lagging. Inputs are only
// applied while there is budget, so a client can't move faster than real time.
const MAX_INPUT_BUDGET = 0.5;
const ENEMY_DAMAGE = 1; // HP per second, per enemy touching a player

// One running match. The server owns all state: clients send input commands
// (one per movement step, numbered by `seq`) and receive authoritative positions
// along with the last `seq` applied, which they use to reconcile prediction.
//
// The player list is fixed when the game starts. A player whose connection
// drops keeps their place (and position) and can be reattached with connect().
// A player at 0 HP is down: they stay where they fell and can't act.
//
// Bullets fly in straight lines and stop at the first wall, closed door or
// enemy. Clients are told when one is fired ('shot') and where it stopped
// ('bulletEnd'), and animate the flight themselves.
//
// Pickups ({ id, kind, x, y }) are items on the floor. For now there's one
// ammo stack in the spawn room, and it stays there however often it's used.
//
// The level ends when a player opens the exit hatch: every standing player in
// the extraction zone escapes. The game then stops and calls `onEnd` with
// { time, players: [{ id, escaped, hp, down }] }, time in seconds.
export class Game {
  constructor(seed, playerIds, { onEnd = () => {} } = {}) {
    this.onEnd = onEnd;
    this.result = null;
    this.seed = seed;
    this.map = generateMap(seed);
    this.players = new Map();
    this.enemies = new Enemies(this.map, createRng(seed ^ 0x5bd1e995));
    this.bullets = []; // { id, x, y, dx, dy, dist }: current position, unit direction, distance flown
    this.nextBulletId = 1;

    const spawns = spawnPoints(this.map, playerIds.length);
    playerIds.forEach((id, i) => {
      this.players.set(id, {
        id,
        socket: null,
        ...spawns[i],
        hp: PLAYER_MAX_HP,
        down: false,
        ammo: PLAYER_START_AMMO,
        ...freshInputState(),
      });
    });

    const ammo = ammoSpot(this.map, createRng(seed ^ 0x2545f491));
    this.pickups = [{ id: 1, kind: 'ammo', ...ammo }];

    this.startedAt = performance.now();
    this.lastTick = this.startedAt;
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stop() {
    clearInterval(this.timer);
  }

  has(id) {
    return this.players.has(id);
  }

  get size() {
    return this.players.size;
  }

  // Attaches a connection to a player and sends them the full game.
  // Input numbering restarts, because the client starts a fresh prediction.
  connect(id, socket) {
    const player = this.players.get(id);
    if (!player) return;
    Object.assign(player, { socket, ...freshInputState() });
    send(socket, {
      type: 'game',
      seed: this.seed,
      you: id,
      ammo: player.ammo,
      map: serializeMap(this.map),
      players: this.playerStates(),
      enemies: this.enemies.positions(),
      pickups: this.pickups,
    });
  }

  disconnect(id) {
    const player = this.players.get(id);
    if (player) Object.assign(player, { socket: null, ...freshInputState() });
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  queueInput(id, { seq, keys, aim }) {
    const player = this.players.get(id);
    if (!player || !Number.isInteger(seq) || !Number.isInteger(keys)) return;
    if (seq <= player.queuedSeq || player.inputs.length >= MAX_QUEUED_INPUTS) return;
    player.queuedSeq = seq;
    player.inputs.push({ seq, keys: keys & KEY_MASK, aim: Number.isFinite(aim) ? aim : null });
  }

  tick() {
    const now = performance.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;

    for (const player of this.players.values()) {
      player.budget = Math.min(player.budget + elapsed, MAX_INPUT_BUDGET);
      while (player.inputs.length && player.budget >= SIM_STEP - 1e-9) {
        const { seq, keys, aim } = player.inputs.shift();
        player.budget -= SIM_STEP;
        // Downed players' inputs are still acknowledged, just not applied.
        if (!player.down) {
          stepPlayer(player, keys, this.map);
          if (keys & KEY.INTERACT) this.interact(player);
          if (keys & KEY.SHOOT && aim !== null) this.fire(player, seq, aim);
        }
        player.lastSeq = seq;
      }
    }

    if (this.result) {
      this.stop();
      this.onEnd(this.result);
      return;
    }

    this.simulate(1 / TICK_RATE);

    // Ammo is per player, so it goes in each player's own message.
    const players = this.playerStates();
    const enemies = this.enemies.positions();
    for (const player of this.players.values()) {
      if (!player.socket) continue;
      send(player.socket, { type: 'state', ack: player.lastSeq, ammo: player.ammo, players, enemies });
    }
  }

  // Advances everything that isn't driven by player input: enemies, bullets and damage.
  simulate(dt) {
    const players = [...this.players.values()];
    this.enemies.update(players, dt);
    this.updateBullets(dt);

    for (const player of players) {
      if (player.down) continue;
      const touching = this.enemies.touching(player);
      if (!touching) continue;
      player.hp = Math.max(0, player.hp - touching * ENEMY_DAMAGE * dt);
      if (player.hp === 0) player.down = true;
    }
  }

  // Fires from the player's center at angle `aim`, if they have ammo.
  // `seq` lets the shooter match this to the bullet it already drew.
  fire(player, seq, aim) {
    if (player.ammo <= 0) return;
    player.ammo--;
    const bullet = { id: this.nextBulletId++, x: player.x, y: player.y, dx: Math.cos(aim), dy: Math.sin(aim), dist: 0 };
    this.bullets.push(bullet);
    const { id, x, y, dx, dy } = bullet;
    this.broadcast({ type: 'shot', id, owner: player.id, seq, x, y, dx, dy });
  }

  // Moves each bullet along its line, stopping it at the first wall, closed
  // door or enemy in its path this tick, or at the end of its range.
  updateBullets(dt) {
    this.bullets = this.bullets.filter((bullet) => {
      const step = Math.min(BULLET_SPEED * dt, BULLET_RANGE - bullet.dist);
      const wall = castRay(this.map, bullet.x, bullet.y, bullet.dx, bullet.dy, step);
      const hit = this.enemies.firstHit(bullet.x, bullet.y, bullet.dx, bullet.dy, wall);
      const travel = hit ? hit.dist : wall;
      bullet.x += bullet.dx * travel;
      bullet.y += bullet.dy * travel;
      bullet.dist += travel;

      if (hit) this.enemies.damage(hit.enemy, 1);
      if (hit || wall < step || bullet.dist >= BULLET_RANGE) {
        this.broadcast({ type: 'bulletEnd', id: bullet.id, dist: bullet.dist });
        return false;
      }
      return true;
    });
  }

  // E: escape through the hatch, take ammo or use a door (see interactionTarget).
  interact(player) {
    const target = interactionTarget(this.map, this.pickups, player, player.ammo);
    if (target?.kind === 'hatch') this.extract();
    else if (target?.kind === 'pickup') this.takeAmmo(player);
    else if (target?.kind === 'door') this.toggleDoor(target.door);
  }

  // The ammo stack tops the player up and stays where it is.
  takeAmmo(player) {
    player.ammo = Math.min(PLAYER_MAX_AMMO, player.ammo + AMMO_PICKUP);
  }

  toggleDoor(door) {
    if (door.open && this.doorBlocked(door)) return;
    door.open = !door.open;
    this.broadcast({ type: 'door', id: door.id, open: door.open });
  }

  // Ends the level: everyone standing in the extraction zone escapes.
  extract() {
    if (this.result) return;
    const { zone } = this.map.exit;
    this.result = {
      time: (performance.now() - this.startedAt) / 1000,
      players: [...this.players.values()].map(({ id, x, y, hp, down }) => ({
        id,
        escaped: !down && pointInRect({ x, y }, zone),
        hp: Math.ceil(hp),
        down,
      })),
    };
  }

  // Whether anyone is standing in the doorway, so it can't be closed.
  doorBlocked(door) {
    return [...this.players.values()].some((p) => bodyOverlapsRect(p, door)) || this.enemies.anyOverlapping(door);
  }

  broadcast(msg) {
    for (const player of this.players.values()) {
      if (player.socket) send(player.socket, msg);
    }
  }

  playerStates() {
    return [...this.players.values()].map(({ id, x, y, hp, down }) => ({
      id,
      x,
      y,
      hp: Math.ceil(hp * 100) / 100, // rounded up, so only a downed player shows 0
      down,
    }));
  }
}

function freshInputState() {
  return { inputs: [], lastSeq: 0, queuedSeq: 0, budget: 0 };
}

// Tile centers in the spawn room, nearest its middle first, one per player.
function spawnPoints(map, count) {
  const room = map.rooms[map.spawnRoom];
  const center = roomCenter(room);
  const points = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) points.push({ x: x + 0.5, y: y + 0.5 });
  }
  const dist = (p) => Math.hypot(p.x - center.x, p.y - center.y);
  points.sort((a, b) => dist(a) - dist(b));
  return points.slice(0, count);
}

// Players spawn on the tiles nearest the room's middle (all within this
// distance even for a full lobby), so the ammo stack is placed farther out.
const SPAWN_CLUSTER_RADIUS = 2.5;

// A random tile center in the spawn room, clear of the spawn cluster and not
// against a wall.
function ammoSpot(map, rng) {
  const room = map.rooms[map.spawnRoom];
  const center = roomCenter(room);
  const spots = [];
  for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
    for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
      const spot = { x: x + 0.5, y: y + 0.5 };
      if (Math.hypot(spot.x - center.x, spot.y - center.y) >= SPAWN_CLUSTER_RADIUS) spots.push(spot);
    }
  }
  return rng.pick(spots);
}
