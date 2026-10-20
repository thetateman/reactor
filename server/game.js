import {
  AMMO_PICKUP, BULLET_RANGE, BULLET_SPEED, FLASHLIGHT_BATTERY, KEY, KEY_MASK, PLAYER_MAX_AMMO, PLAYER_MAX_HP,
  PLAYER_START_AMMO, REACTOR_COOL_TIME, REACTOR_HEAT_TIME, SIM_STEP, TICK_RATE, TILE,
} from '../shared/constants.js';
import { interactionTarget, nearReactor, pointInRect } from '../shared/interact.js';
import { castRay, serializeMap } from '../shared/map.js';
import { isPowered } from '../shared/reactor.js';
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
// The reactor in the spawn room starts cold. With its fuel rod in it heats
// up, and with the rod out it cools (see REACTOR_* in shared/constants.js).
// At 100 it melts down, killing everyone and ending the level. Its dial is
// hidden from everyone until someone first uses the controls (`used`).
//
// Each room has a light (`lights[roomId]`); all are on while the reactor makes power.
// Each player has a flashlight that drains its battery while it's on. Lighting
// itself is drawn by the clients; the server only tracks what's switched on.
//
// The level ends when a player opens the exit hatch (every standing player in
// the extraction zone escapes) or the reactor melts down. The game then stops
// and calls `onEnd` with
// { outcome: 'escaped' | 'meltdown', time, players: [{ id, escaped, hp, down }] },
// time in seconds.
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
    this.reactor = { temperature: 0, rodIn: false, used: false };
    this.lights = this.map.rooms.map(() => false);

    const spawns = spawnPoints(this.map, playerIds.length);
    playerIds.forEach((id, i) => {
      this.players.set(id, {
        id,
        socket: null,
        ...spawns[i],
        hp: PLAYER_MAX_HP,
        down: false,
        ammo: PLAYER_START_AMMO,
        flashlight: false,
        battery: FLASHLIGHT_BATTERY, // seconds left
        aim: 0, // where they're pointing, in radians, for drawing their flashlight beam
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
      battery: player.battery,
      map: serializeMap(this.map),
      players: this.playerStates(),
      enemies: this.enemies.positions(),
      pickups: this.pickups,
      reactor: this.reactorState(),
      lights: this.lights,
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
          if (keys & KEY.FLASHLIGHT) this.toggleFlashlight(player);
        }
        player.lastSeq = seq;
      }
    }

    if (!this.result) this.simulate(1 / TICK_RATE);
    if (this.result) {
      this.stop();
      this.onEnd(this.result);
      return;
    }

    // Ammo is per player, so it goes in each player's own message.
    const players = this.playerStates();
    const enemies = this.enemies.positions();
    const reactor = this.reactorState();
    const { lights } = this;
    for (const player of this.players.values()) {
      if (!player.socket) continue;
      const { lastSeq: ack, ammo } = player;
      const battery = Math.round(player.battery * 10) / 10;
      send(player.socket, { type: 'state', ack, ammo, battery, players, enemies, reactor, lights });
    }
  }

  // Advances everything that isn't driven by player input: the reactor,
  // enemies, bullets and damage.
  simulate(dt) {
    this.updateReactor(dt);
    if (this.result) return;
    this.lights.fill(isPowered(this.reactor.temperature));

    const players = [...this.players.values()];
    this.enemies.update(players, dt);
    this.updateBullets(dt);
    this.drainBatteries(dt);

    for (const player of players) {
      if (player.down) continue;
      const touching = this.enemies.touching(player);
      if (!touching) continue;
      player.hp = Math.max(0, player.hp - touching * ENEMY_DAMAGE * dt);
      if (player.hp === 0) Object.assign(player, { down: true, flashlight: false });
    }
  }

  updateReactor(dt) {
    const reactor = this.reactor;
    const change = reactor.rodIn ? (100 / REACTOR_HEAT_TIME) * dt : -(100 / REACTOR_COOL_TIME) * dt;
    reactor.temperature = Math.min(100, Math.max(0, reactor.temperature + change));
    if (reactor.temperature >= 100) this.meltDown();
  }

  // The reactor's Insert and Extract buttons. Only someone standing next to it can use them.
  controlReactor(id, action) {
    const player = this.players.get(id);
    if (!player || player.down || !nearReactor(this.map, player)) return;
    if (action !== 'insert' && action !== 'extract') return;
    this.reactor.rodIn = action === 'insert';
    this.reactor.used = true;
  }

  // Everyone on the map dies.
  meltDown() {
    if (this.result) return;
    this.result = {
      outcome: 'meltdown',
      time: (performance.now() - this.startedAt) / 1000,
      players: [...this.players.values()].map(({ id }) => ({ id, escaped: false, hp: 0, down: true })),
    };
  }

  // Right-click: on if there's battery left, off otherwise.
  toggleFlashlight(player) {
    player.flashlight = !player.flashlight && player.battery > 0;
  }

  setAim(id, angle) {
    const player = this.players.get(id);
    if (player && Number.isFinite(angle)) player.aim = angle;
  }

  drainBatteries(dt) {
    for (const player of this.players.values()) {
      if (!player.flashlight) continue;
      player.battery = Math.max(0, player.battery - dt);
      if (player.battery === 0) player.flashlight = false;
    }
  }

  reactorState() {
    const { temperature, rodIn, used } = this.reactor;
    return { temperature: Math.round(temperature * 100) / 100, rodIn, used };
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
  // At the reactor, E opens its controls on the client; nothing happens here.
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
      outcome: 'escaped',
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
    return [...this.players.values()].map(({ id, x, y, hp, down, flashlight, aim }) => ({
      id,
      x,
      y,
      hp: Math.ceil(hp * 100) / 100, // rounded up, so only a downed player shows 0
      down,
      flashlight,
      aim: Math.round(aim * 100) / 100,
    }));
  }
}

function freshInputState() {
  return { inputs: [], lastSeq: 0, queuedSeq: 0, budget: 0 };
}

// How far a spot is from the reactor's edge, counting diagonals as one step
// (so tiles touching the reactor, corners included, are 0.5 away).
function reactorClearance(map, spot) {
  const { reactor } = map;
  return Math.max(
    Math.abs(spot.x - (reactor.x + reactor.w / 2)) - reactor.w / 2,
    Math.abs(spot.y - (reactor.y + reactor.h / 2)) - reactor.h / 2,
  );
}

// Floor tile centers in the spawn room, nearest the reactor first, one per
// player. A full lobby fits in the ring of tiles right around the reactor.
function spawnPoints(map, count) {
  const [room] = map.rooms[map.spawnRoom].rects;
  const points = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (map.tiles[y * map.width + x] === TILE.FLOOR) points.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  const dist = (p) => Math.hypot(p.x - (map.reactor.x + map.reactor.w / 2), p.y - (map.reactor.y + map.reactor.h / 2));
  points.sort((a, b) => dist(a) - dist(b));
  return points.slice(0, count);
}

// Keeps the ammo stack clear of the spawn ring and out of reach of the
// reactor's controls, so E there always means "take ammo".
const AMMO_REACTOR_CLEARANCE = 3;

// A random tile center in the spawn room, away from the reactor and not
// against a wall.
function ammoSpot(map, rng) {
  const [room] = map.rooms[map.spawnRoom].rects;
  const spots = [];
  for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
    for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
      const spot = { x: x + 0.5, y: y + 0.5 };
      if (reactorClearance(map, spot) >= AMMO_REACTOR_CLEARANCE) spots.push(spot);
    }
  }
  return rng.pick(spots);
}
