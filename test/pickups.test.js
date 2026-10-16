import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, PICKUP_RANGE, PLAYER_MAX_AMMO } from '../shared/constants.js';
import { Game } from '../server/game.js';
import { MAX_PLAYERS } from '../server/lobby.js';

// A stopped game (no timer, no enemies) with player 'p' standing next to the ammo stack.
function setup(seed = 11) {
  const game = new Game(seed, ['p']);
  game.stop();
  game.enemies.maybeSpawn = () => {};
  const stack = game.pickups.find((p) => p.kind === 'ammo');
  const player = game.players.get('p');
  Object.assign(player, { x: stack.x + 1, y: stack.y });
  return { game, player, stack };
}

// Queues commands for player 'p' and applies them, as if they arrived over a second.
function send(game, ...commands) {
  const player = game.players.get('p');
  let seq = player.queuedSeq;
  for (const command of commands) game.queueInput('p', { seq: ++seq, ...command });
  game.lastTick -= 1000;
  game.tick();
}

test('every game starts with an ammo stack in the spawn room, clear of the players', () => {
  const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`);
  for (let seed = 1; seed <= 100; seed++) {
    const game = new Game(seed, ids);
    game.stop();
    const stacks = game.pickups.filter((p) => p.kind === 'ammo');
    assert.equal(stacks.length, 1);

    const [stack] = stacks;
    const room = game.map.rooms[game.map.spawnRoom];
    assert.ok(stack.x > room.x + 1 && stack.x < room.x + room.w - 1, `seed ${seed}: not inside the spawn room`);
    assert.ok(stack.y > room.y + 1 && stack.y < room.y + room.h - 1, `seed ${seed}: not inside the spawn room`);
    for (const player of game.players.values()) {
      assert.ok(Math.hypot(player.x - stack.x, player.y - stack.y) >= 1, `seed ${seed}: under a player`);
    }
  }
});

test('taking ammo fills up to the max, and the stack stays', () => {
  const { game, player, stack } = setup();
  player.ammo = 5;
  send(game, { keys: KEY.PICKUP, pickup: stack.id });
  assert.equal(player.ammo, PLAYER_MAX_AMMO);

  player.ammo = 15;
  send(game, { keys: KEY.PICKUP, pickup: stack.id });
  assert.equal(player.ammo, PLAYER_MAX_AMMO, 'capped at the max');
  assert.ok(game.pickups.includes(stack));
});

test('ammo is only taken within reach, by a standing player, with an existing stack', () => {
  const { game, player, stack } = setup();
  player.ammo = 3;

  player.x = stack.x + PICKUP_RANGE + 0.2;
  send(game, { keys: KEY.PICKUP, pickup: stack.id });
  assert.equal(player.ammo, 3, 'too far away');

  player.x = stack.x + 1;
  send(game, { keys: KEY.PICKUP, pickup: 999 });
  assert.equal(player.ammo, 3, 'no such pickup');

  player.down = true;
  send(game, { keys: KEY.PICKUP, pickup: stack.id });
  assert.equal(player.ammo, 3, 'downed');
});
