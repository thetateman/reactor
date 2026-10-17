import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENEMY_MAX_HP, ENEMY_RADIUS, KEY, PLAYER_MAX_AMMO, PLAYER_MAX_HP } from '../shared/constants.js';
import { isSolid, lineOfSight } from '../shared/map.js';
import { Game } from '../server/game.js';

const TICK = 0.05;

// A floor spot in the spawn room, just left of the reactor in its middle (the room's center is the reactor).
const besideReactor = ({ reactor }) => ({ x: reactor.x - 0.5, y: reactor.y + reactor.h / 2 });

// A stopped game (no timer) with one player, `p`, in the spawn room beside the reactor.
function setup(seed = 11) {
  const game = new Game(seed, ['p']);
  game.stop();
  const room = game.map.rooms[game.map.spawnRoom];
  const player = game.players.get('p');
  Object.assign(player, besideReactor(game.map));
  return { game, room, player };
}

function run(game, seconds) {
  for (let t = 0; t < seconds; t += TICK) game.simulate(TICK);
}

function addEnemy(game, x, y) {
  const enemy = { id: game.enemies.nextId++, x, y, hp: ENEMY_MAX_HP, mode: 'idle', goal: null, wait: 1, stuck: 0 };
  game.enemies.list.push(enemy);
  return enemy;
}

// A door on the spawn room's wall, with tile-center points just inside and outside it.
function doorOfRoom(map, room) {
  for (const door of map.doors) {
    const horizontal = door.h === 1;
    const onRoom = horizontal
      ? (door.y === room.y - 1 || door.y === room.y + room.h) && door.x >= room.x && door.x < room.x + room.w
      : (door.x === room.x - 1 || door.x === room.x + room.w) && door.y >= room.y && door.y < room.y + room.h;
    if (!onRoom) continue;
    const cx = door.x + door.w / 2;
    const cy = door.y + door.h / 2;
    const into = horizontal
      ? { x: 0, y: door.y < room.y ? 1 : -1 }
      : { x: door.x < room.x ? 1 : -1, y: 0 };
    return {
      door,
      inside: { x: cx + into.x * 2.5, y: cy + into.y * 2.5 },
      outside: { x: cx - into.x * 1.5, y: cy - into.y * 1.5 },
    };
  }
  throw new Error('spawn room has no door');
}

test('line of sight is blocked by walls and closed doors only', () => {
  const { game, room } = setup();
  const { map } = game;
  assert.ok(lineOfSight(map, room.x + 0.5, room.y + 0.5, room.x + room.w - 0.5, room.y + 0.5));
  assert.ok(!lineOfSight(map, room.x + 0.5, room.y + 0.5, room.x + 0.5, room.y - 1.5));

  const { door, inside, outside } = doorOfRoom(map, room);
  assert.ok(!lineOfSight(map, inside.x, inside.y, outside.x, outside.y));
  door.open = true;
  assert.ok(lineOfSight(map, inside.x, inside.y, outside.x, outside.y));
});

test('enemies spawn about every 5 seconds, never in a room with a player', () => {
  const { game, room, player } = setup();
  const spawned = [];
  for (let t = 0; t < 100; t += TICK) {
    const before = game.enemies.list.length;
    game.enemies.maybeSpawn([player], TICK);
    spawned.push(...game.enemies.list.slice(before));
  }
  assert.ok(spawned.length >= 12 && spawned.length <= 30, `${spawned.length} spawns in 100 s`);
  for (const e of spawned) {
    const inSpawnRoom = e.x >= room.x && e.x < room.x + room.w && e.y >= room.y && e.y < room.y + room.h;
    assert.ok(!inSpawnRoom, 'spawned in the occupied room');
  }
});

test('an enemy that sees a player chases them and drains 1 HP per second', () => {
  const { game, room, player } = setup();
  game.enemies.maybeSpawn = () => {}; // just the one enemy
  const enemy = addEnemy(game, room.x + 0.5, room.y + 0.5);

  run(game, 3);
  assert.equal(enemy.mode, 'chase');
  assert.equal(game.enemies.touching(player), 1);

  const hp = player.hp;
  run(game, 2);
  assert.ok(Math.abs(hp - player.hp - 2) < 0.06, `lost ${hp - player.hp} HP in 2 s`);
});

test('a player at 0 HP goes down and can no longer move', () => {
  const { game, room, player } = setup();
  game.enemies.maybeSpawn = () => {};
  addEnemy(game, room.x + 0.5, room.y + 0.5);

  run(game, PLAYER_MAX_HP + 3);
  assert.equal(player.hp, 0);
  assert.equal(player.down, true);

  const at = { x: player.x, y: player.y };
  for (let seq = 1; seq <= 10; seq++) game.queueInput('p', { seq, keys: KEY.RIGHT });
  game.lastTick -= 1000;
  game.tick();
  assert.deepEqual({ x: player.x, y: player.y }, at);
  assert.equal(player.lastSeq, 10);
  assert.equal(game.enemies.list[0].mode === 'chase', false, 'enemies ignore downed players');
});

test('closed doors stop enemies seeing and reaching players', () => {
  const { game, room, player } = setup();
  game.enemies.maybeSpawn = () => {};
  const { door, inside, outside } = doorOfRoom(game.map, room);
  Object.assign(player, inside);
  const enemy = addEnemy(game, outside.x, outside.y);

  run(game, 3);
  assert.notEqual(enemy.mode, 'chase');
  assert.equal(player.hp, PLAYER_MAX_HP);

  door.open = true;
  enemy.x = outside.x; // in case it wandered off
  enemy.y = outside.y;
  run(game, 3);
  assert.equal(game.enemies.touching(player), 1);
});

test('enemies never end up inside walls', () => {
  const game = new Game(23, ['a', 'b']);
  game.stop();
  for (const door of game.map.doors) door.open = true;
  const eps = 1e-6;
  for (let t = 0; t < 120; t += TICK) {
    game.simulate(TICK);
    for (const e of game.enemies.list) {
      for (let y = Math.floor(e.y - ENEMY_RADIUS + eps); y <= Math.floor(e.y + ENEMY_RADIUS - eps); y++) {
        for (let x = Math.floor(e.x - ENEMY_RADIUS + eps); x <= Math.floor(e.x + ENEMY_RADIUS - eps); x++) {
          assert.ok(!isSolid(game.map, x, y), `enemy ${e.id} in a wall at t=${t.toFixed(2)}`);
        }
      }
    }
  }
  assert.ok(game.enemies.list.length > 0);
});

// Queues commands for player 'p' and applies them, as if they arrived over a second.
function send(game, ...commands) {
  const player = game.players.get('p');
  let seq = player.queuedSeq;
  for (const command of commands) game.queueInput('p', { seq: ++seq, ...command });
  game.lastTick -= 1000;
  game.tick();
}

const aimAt = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

test('players start with no ammo, so they cannot shoot', () => {
  const { game, player } = setup();
  game.enemies.maybeSpawn = () => {};
  assert.equal(player.ammo, 0);
  send(game, { keys: KEY.SHOOT, aim: 0 });
  assert.equal(game.nextBulletId - 1, 0, 'no bullet was fired');
});

test('three hits kill an enemy, and each shot uses one round', () => {
  const { game, room, player } = setup();
  game.enemies.maybeSpawn = () => {};
  player.ammo = PLAYER_MAX_AMMO;
  const enemy = addEnemy(game, room.x + 0.5, room.y + 0.5);
  enemy.wait = Infinity; // stand still

  for (let shot = 1; shot <= 3; shot++) {
    send(game, { keys: KEY.SHOOT, aim: aimAt(player, enemy) });
    run(game, 1);
    assert.equal(player.ammo, PLAYER_MAX_AMMO - shot);
    assert.equal(enemy.hp, 3 - shot);
  }
  assert.equal(game.enemies.list.length, 0, 'dead enemies are removed');
  assert.equal(game.bullets.length, 0);
});

test('a full gun fires 20 rounds', () => {
  const { game, player } = setup();
  game.enemies.maybeSpawn = () => {};
  player.ammo = PLAYER_MAX_AMMO;
  send(game, ...Array.from({ length: 25 }, () => ({ keys: KEY.SHOOT, aim: 0 })));
  assert.equal(player.ammo, 0);
  run(game, 3);
  assert.equal(game.bullets.length, 0);
  assert.equal(game.nextBulletId - 1, 20, 'only 20 bullets were fired');
});

test('bullets stop at walls and closed doors', () => {
  const { game, room, player } = setup();
  game.enemies.maybeSpawn = () => {};
  const { door, inside, outside } = doorOfRoom(game.map, room);
  Object.assign(player, inside, { ammo: PLAYER_MAX_AMMO });
  const behindDoor = addEnemy(game, outside.x, outside.y);
  behindDoor.wait = Infinity;

  send(game, { keys: KEY.SHOOT, aim: aimAt(player, behindDoor) });
  run(game, 1);
  assert.equal(behindDoor.hp, 3, 'closed door stopped the bullet');

  door.open = true;
  send(game, { keys: KEY.SHOOT, aim: aimAt(player, behindDoor) });
  run(game, 1);
  assert.equal(behindDoor.hp, 2, 'open door let it through');

  // Straight up at the room's top edge (a wall, or that door closed again):
  // the bullet ends there, short of its range.
  door.open = false;
  const ends = [];
  player.socket = { readyState: 1, send: (d) => ends.push(JSON.parse(d)) };
  Object.assign(player, besideReactor(game.map));
  send(game, { keys: KEY.SHOOT, aim: -Math.PI / 2 });
  run(game, 2);
  const end = ends.find((m) => m.type === 'bulletEnd');
  assert.ok(Math.abs(end.dist - (player.y - room.y)) < 1e-9, `stopped after ${end.dist} tiles`);
});

test('downed players cannot shoot', () => {
  const { game, player } = setup();
  game.enemies.maybeSpawn = () => {};
  Object.assign(player, { down: true, ammo: PLAYER_MAX_AMMO });
  send(game, { keys: KEY.SHOOT, aim: 0 });
  assert.equal(player.ammo, PLAYER_MAX_AMMO);
  assert.equal(game.bullets.length, 0);
});
