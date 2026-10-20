import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKUP_RANGE, REACTOR_RANGE, TILE } from '../shared/constants.js';
import { interactionTarget } from '../shared/interact.js';
import { distanceToRect, isSolid } from '../shared/map.js';
import { isPowered, reactorZone } from '../shared/reactor.js';
import { Game } from '../server/game.js';
import { MAX_PLAYERS } from '../server/lobby.js';

const TICK = 0.05;

// A stopped game (no timer, no enemies) with player 'p' standing beside the reactor.
function setup(ids = ['p']) {
  const ended = [];
  const game = new Game(11, ids, { onEnd: (result) => ended.push(result) });
  game.stop();
  game.enemies.maybeSpawn = () => {};
  const { reactor } = game.map;
  const player = game.players.get(ids[0]);
  Object.assign(player, { x: reactor.x - 0.5, y: reactor.y + reactor.h / 2 });
  return { game, ended, player };
}

function run(game, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += TICK) game.simulate(TICK);
}

test('the reactor starts cold, with the rod out, no power and its dial hidden', () => {
  const { game } = setup();
  assert.deepEqual(game.reactor, { temperature: 0, rodIn: false, used: false });
  assert.equal(isPowered(game.reactor.temperature), false);
});

test('with the rod in, power comes on after 72 s and it melts down at 4 minutes', () => {
  const { game, player } = setup();
  game.controlReactor(player.id, 'insert');
  assert.equal(game.reactor.rodIn, true);

  run(game, 71.9);
  assert.equal(isPowered(game.reactor.temperature), false);
  run(game, 0.2);
  assert.equal(isPowered(game.reactor.temperature), true);

  run(game, 240 - 72.1 - 0.1);
  assert.equal(game.result, null, 'not yet');
  run(game, 0.2);
  assert.equal(game.result?.outcome, 'meltdown');
});

test('with the rod out, it cools at the same rate and stops at cold', () => {
  const { game, player } = setup();
  game.reactor.temperature = 50;
  game.controlReactor(player.id, 'insert');
  game.controlReactor(player.id, 'extract');
  assert.equal(game.reactor.rodIn, false);

  run(game, 60);
  assert.ok(Math.abs(game.reactor.temperature - 25) < 1e-6, `${game.reactor.temperature}`);
  run(game, 120);
  assert.equal(game.reactor.temperature, 0);
});

test('the dial: blue below 30, green to 70, red above; power from 30 up', () => {
  assert.equal(reactorZone(29.9), 'cold');
  assert.equal(reactorZone(30), 'stable');
  assert.equal(reactorZone(69.9), 'stable');
  assert.equal(reactorZone(70), 'overheating');
  assert.equal(isPowered(29.9), false);
  assert.equal(isPowered(30), true);
  assert.equal(isPowered(99), true, 'still powered while overheating');
});

test('only a standing player next to the reactor can use its controls', () => {
  const { game, player } = setup(['p', 'far']);
  const far = game.players.get('far');
  Object.assign(far, { x: game.map.reactor.x - REACTOR_RANGE - 1, y: player.y });
  game.controlReactor('far', 'insert');
  assert.equal(game.reactor.rodIn, false, 'too far away');

  player.down = true;
  game.controlReactor('p', 'insert');
  assert.equal(game.reactor.rodIn, false, 'downed');

  player.down = false;
  game.controlReactor('p', 'nonsense');
  assert.equal(game.reactor.rodIn, false);
  game.controlReactor('p', 'insert');
  assert.equal(game.reactor.rodIn, true);
});

test('once anyone uses the controls, everyone is told the dial is revealed', () => {
  const { game, player } = setup(['p', 'q']);
  const far = game.players.get('q');
  Object.assign(far, { x: game.map.reactor.x - REACTOR_RANGE - 1, y: player.y });
  const seenByQ = [];
  far.socket = { readyState: 1, send: (d) => seenByQ.push(JSON.parse(d)) };

  game.controlReactor('q', 'insert'); // out of reach: doesn't count
  assert.equal(game.reactor.used, false);

  game.controlReactor('p', 'insert');
  game.controlReactor('p', 'extract');
  assert.equal(game.reactor.used, true, 'and it stays revealed');
  game.lastTick = performance.now();
  game.tick();
  assert.equal(seenByQ.findLast((m) => m.type === 'state').reactor.used, true);
});

test('the reactor is solid, and E beside it opens its controls', () => {
  const { game, player } = setup();
  const { map } = game;
  const { reactor } = map;
  for (let y = reactor.y; y < reactor.y + reactor.h; y++) {
    for (let x = reactor.x; x < reactor.x + reactor.w; x++) {
      assert.equal(map.tiles[y * map.width + x], TILE.REACTOR);
      assert.ok(isSolid(map, x, y));
    }
  }
  assert.equal(interactionTarget(map, game.pickups, player, player.ammo)?.kind, 'reactor');
});

test('players spawn on the floor around the reactor, and the ammo stack is out of its reach', () => {
  const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`);
  for (let seed = 1; seed <= 100; seed++) {
    const game = new Game(seed, ids);
    game.stop();
    const { map } = game;
    for (const p of game.players.values()) {
      assert.equal(map.tiles[Math.floor(p.y) * map.width + Math.floor(p.x)], TILE.FLOOR, `seed ${seed}`);
      assert.ok(distanceToRect(p.x, p.y, map.reactor) <= REACTOR_RANGE, `seed ${seed}: spawned out of the reactor's reach`);
    }
    const [stack] = game.pickups;
    const closest = distanceToRect(stack.x, stack.y, map.reactor);
    assert.ok(closest > REACTOR_RANGE + PICKUP_RANGE, `seed ${seed}: ammo stack ${closest} from the reactor`);
  }
});

test('a meltdown kills everyone and ends the level', () => {
  const { game, ended, player } = setup(['p', 'q']);
  game.controlReactor(player.id, 'insert');
  game.reactor.temperature = 99.99;
  game.lastTick = performance.now();
  game.tick();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome, 'meltdown');
  assert.deepEqual(ended[0].players.map((p) => p.escaped), [false, false]);
  assert.ok(ended[0].players.every((p) => p.down && p.hp === 0));
});
