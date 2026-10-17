import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLASHLIGHT_BATTERY, KEY, REACTOR_POWER_MIN, TILE } from '../shared/constants.js';
import { lineOfSight } from '../shared/map.js';
import { WALL_PEEK, conePolygon, visibilityPolygon, walkRay, withinAngle } from '../shared/vision.js';
import { Game } from '../server/game.js';

const TICK = 0.05;

function setup(ids = ['p']) {
  const game = new Game(11, ids);
  game.stop();
  game.enemies.maybeSpawn = () => {};
  const { reactor } = game.map;
  const player = game.players.get(ids[0]);
  Object.assign(player, { x: reactor.x - 0.5, y: reactor.y + reactor.h / 2 });
  return { game, player };
}

function run(game, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += TICK) game.simulate(TICK);
}

// Queues commands for a player and applies them, as if they arrived over a second.
function send(game, id, ...commands) {
  const player = game.players.get(id);
  let seq = player.queuedSeq;
  for (const command of commands) game.queueInput(id, { seq: ++seq, ...command });
  game.lastTick -= 1000;
  game.tick();
}

test('rays visit tiles in order and stop at the first solid one', () => {
  const { game, player } = setup();
  const { map } = game;
  // Looking right from beside the reactor: the next tile is the reactor itself.
  const visited = [];
  const hit = walkRay(map, player.x, player.y, 1, 0, 20, (i, dist) => visited.push([i, dist]));
  assert.equal(hit, 0.5);
  assert.equal(visited.length, 2);
  assert.equal(map.tiles[visited[1][0]], TILE.REACTOR);
  assert.ok(visited.every(([, d], i) => i === 0 || d >= visited[i - 1][1]));
});

test('the visibility outline never reaches past the first wall', () => {
  for (const seed of [1, 2, 3]) {
    const game = new Game(seed, ['p']);
    game.stop();
    const { map } = game;
    const { x, y } = game.players.get('p');
    const points = visibilityPolygon(map, x, y, 30, 360);
    for (let i = 0; i < points.length; i += 2) {
      const dx = points[i] - x;
      const dy = points[i + 1] - y;
      const len = Math.hypot(dx, dy);
      assert.ok(len <= 30 + 1e-9);
      // Backing off the peek leaves a clear line from the eye.
      const back = Math.max(0, len - WALL_PEEK - 1e-6) / len;
      assert.ok(lineOfSight(map, x, y, x + dx * back, y + dy * back), `seed ${seed}: sees through a wall`);
    }
  }
});

test('a flashlight cone starts at the player and stays within its angle and range', () => {
  const { game, player } = setup();
  const points = conePolygon(game.map, player.x, player.y, Math.PI / 2, Math.PI / 6, 10, 24);
  assert.equal(points[0], player.x);
  assert.equal(points[1], player.y);
  for (let i = 2; i < points.length; i += 2) {
    const dx = points[i] - player.x;
    const dy = points[i + 1] - player.y;
    assert.ok(Math.hypot(dx, dy) <= 10 + 1e-9);
    assert.ok(withinAngle(Math.atan2(dy, dx), Math.PI / 2, Math.PI / 6 + 1e-9));
  }
  assert.ok(withinAngle(-Math.PI + 0.05, Math.PI - 0.05, 0.2), 'wraps around');
});

test('room and hallway lights are on while the reactor makes power', () => {
  const { game } = setup();
  assert.ok(game.lights.length === game.map.rooms.length && game.lights.every((on) => !on));
  assert.equal(game.hallLights, false);
  game.reactor.temperature = REACTOR_POWER_MIN + 10;
  run(game, TICK);
  assert.ok(game.lights.every((on) => on));
  assert.equal(game.hallLights, true);
  game.reactor.temperature = REACTOR_POWER_MIN - 1;
  run(game, TICK);
  assert.ok(game.lights.every((on) => !on));
  assert.equal(game.hallLights, false);
});

test('right-click toggles the flashlight, which drains its battery only while on', () => {
  const { game, player } = setup();
  assert.equal(player.flashlight, false);
  assert.equal(player.battery, FLASHLIGHT_BATTERY);

  send(game, 'p', { keys: KEY.FLASHLIGHT });
  assert.equal(player.flashlight, true);
  const afterOn = player.battery;
  run(game, 10);
  assert.ok(Math.abs(afterOn - player.battery - 10) < 1e-6, `drained ${afterOn - player.battery}`);

  send(game, 'p', { keys: KEY.FLASHLIGHT });
  assert.equal(player.flashlight, false);
  const afterOff = player.battery;
  run(game, 10);
  assert.equal(player.battery, afterOff);
});

test('a flat battery turns the flashlight off for good', () => {
  const { game, player } = setup();
  Object.assign(player, { flashlight: true, battery: 0.5 });
  run(game, 1);
  assert.equal(player.battery, 0);
  assert.equal(player.flashlight, false);
  send(game, 'p', { keys: KEY.FLASHLIGHT });
  assert.equal(player.flashlight, false, 'cannot turn back on');
});

test('going down turns the flashlight off', () => {
  const { game, player } = setup();
  Object.assign(player, { flashlight: true, hp: 0.01 });
  game.enemies.list.push({ id: 1, x: player.x - 0.6, y: player.y, hp: 3, mode: 'idle', goal: null, wait: 99, stuck: 0 });
  run(game, 0.5);
  assert.equal(player.down, true);
  assert.equal(player.flashlight, false);
});

test('everyone sees where each flashlight points; battery is only in your own state', () => {
  const { game, player } = setup(['p', 'q']);
  const messages = { p: [], q: [] };
  for (const id of ['p', 'q']) {
    game.players.get(id).socket = { readyState: 1, send: (d) => messages[id].push(JSON.parse(d)) };
  }
  game.setAim('p', 1.234);
  game.setAim('p', NaN); // ignored
  send(game, 'p', { keys: KEY.FLASHLIGHT });

  const seenByQ = messages.q.findLast((m) => m.type === 'state').players.find((x) => x.id === 'p');
  assert.equal(seenByQ.flashlight, true);
  assert.equal(seenByQ.aim, 1.23);
  assert.equal(player.aim, 1.234);
  const own = messages.p.findLast((m) => m.type === 'state');
  assert.ok(own.battery <= FLASHLIGHT_BATTERY && own.battery > FLASHLIGHT_BATTERY - 2);
  assert.ok(Array.isArray(own.lights));
  assert.equal(typeof own.hallLights, 'boolean');
});
