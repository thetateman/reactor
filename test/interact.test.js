import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, PICKUP_RANGE, PLAYER_MAX_AMMO } from '../shared/constants.js';
import { pointInRect } from '../shared/interact.js';
import { Game } from '../server/game.js';
import { MAX_PLAYERS } from '../server/lobby.js';

// A stopped game (no timer, no enemies) with the given players.
function setup(ids = ['p'], seed = 11) {
  const ended = [];
  const game = new Game(seed, ids, { onEnd: (result) => ended.push(result) });
  game.stop();
  game.enemies.maybeSpawn = () => {};
  const stack = game.pickups.find((p) => p.kind === 'ammo');
  return { game, ended, stack, player: game.players.get(ids[0]) };
}

// Queues commands for a player and applies them, as if they arrived over a second.
function send(game, id, ...commands) {
  const player = game.players.get(id);
  let seq = player.queuedSeq;
  for (const command of commands) game.queueInput(id, { seq: ++seq, ...command });
  game.lastTick -= 1000;
  game.tick();
}

const press = (game, id = 'p') => send(game, id, { keys: KEY.INTERACT });
const center = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

test('every game starts with an ammo stack in the spawn room, clear of the players', () => {
  const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`);
  for (let seed = 1; seed <= 100; seed++) {
    const game = new Game(seed, ids);
    game.stop();
    const stacks = game.pickups.filter((p) => p.kind === 'ammo');
    assert.equal(stacks.length, 1);

    const [stack] = stacks;
    const [room] = game.map.rooms[game.map.spawnRoom].rects;
    assert.ok(stack.x > room.x + 1 && stack.x < room.x + room.w - 1, `seed ${seed}: not inside the spawn room`);
    assert.ok(stack.y > room.y + 1 && stack.y < room.y + room.h - 1, `seed ${seed}: not inside the spawn room`);
    for (const player of game.players.values()) {
      assert.ok(Math.hypot(player.x - stack.x, player.y - stack.y) >= 1, `seed ${seed}: under a player`);
    }
  }
});

test('E next to the ammo stack fills up to the max, and the stack stays', () => {
  const { game, player, stack } = setup();
  Object.assign(player, { x: stack.x + 1, y: stack.y, ammo: 5 });
  press(game);
  assert.equal(player.ammo, PLAYER_MAX_AMMO);

  player.ammo = 15;
  press(game);
  assert.equal(player.ammo, PLAYER_MAX_AMMO, 'capped at the max');
  assert.ok(game.pickups.includes(stack));
});

test('ammo is only taken within reach and by a standing player', () => {
  const { game, player, stack } = setup();
  Object.assign(player, { x: stack.x + PICKUP_RANGE + 0.2, y: stack.y, ammo: 3 });
  press(game);
  assert.equal(player.ammo, 3, 'too far away');

  Object.assign(player, { x: stack.x + 1, down: true });
  press(game);
  assert.equal(player.ammo, 3, 'downed');
});

test('E on the hatch ends the level, and everyone standing in the zone escapes', () => {
  const { game, ended } = setup(['opener', 'inZone', 'outside', 'downInZone']);
  const { hatch, zone } = game.map.exit;
  const place = (id, pos, extra = {}) => Object.assign(game.players.get(id), pos, extra);
  place('opener', center(hatch), { hp: 7.2 });
  place('inZone', { x: zone.x + 0.5, y: zone.y + 0.5 }, { hp: 4 });
  place('outside', { x: zone.x - 1.5, y: zone.y + 0.5 });
  place('downInZone', { x: zone.x + zone.w - 0.5, y: zone.y + 0.5 }, { hp: 0, down: true });

  press(game, 'opener');
  assert.equal(ended.length, 1);
  const [result] = ended;
  const byId = Object.fromEntries(result.players.map((p) => [p.id, p]));
  assert.deepEqual(byId.opener, { id: 'opener', escaped: true, hp: 8, down: false });
  assert.deepEqual(byId.inZone, { id: 'inZone', escaped: true, hp: 4, down: false });
  assert.equal(byId.outside.escaped, false);
  assert.equal(byId.downInZone.escaped, false);
  assert.ok(result.time >= 0);
});

test('E in the zone but off the hatch does not end the level', () => {
  const { game, ended, player } = setup();
  const { hatch, zone } = game.map.exit;
  Object.assign(player, { x: zone.x + 0.5, y: zone.y + 0.5 });
  assert.ok(pointInRect(player, zone) && !pointInRect(player, hatch));
  press(game);
  assert.equal(ended.length, 0);
});
