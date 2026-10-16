import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, PLAYER_SPEED, SIM_STEP } from '../shared/constants.js';
import { Game } from '../server/game.js';
import * as lobbies from '../server/lobby.js';

function fakeSocket() {
  return {
    readyState: 1, // WebSocket.OPEN
    messages: [],
    send(data) {
      this.messages.push(JSON.parse(data));
    },
    last(type) {
      return this.messages.findLast((m) => m.type === type);
    },
  };
}

function leaveAll(...ids) {
  for (const id of ids) lobbies.leaveLobby(id);
}

test('the creator hosts, and friends join by code', () => {
  const a = fakeSocket();
  const b = fakeSocket();
  lobbies.createLobby('a', a, '  Ada ');
  const { code } = a.last('lobby').lobby;
  assert.match(code, /^[A-Z]{4}$/);

  lobbies.joinLobby('b', b, code.toLowerCase(), 'Bo');
  const lobby = a.last('lobby').lobby;
  assert.deepEqual(b.last('lobby').lobby, lobby);
  assert.equal(lobby.hostId, 'a');
  assert.deepEqual(lobby.players.map((p) => p.name), ['Ada', 'Bo']);
  assert.notEqual(lobby.players[0].color, lobby.players[1].color);
  leaveAll('a', 'b');
});

test('joining rejects unknown codes, blank names and full lobbies', () => {
  const host = fakeSocket();
  lobbies.joinLobby('x', host, 'ZZZZ', 'X');
  assert.match(host.last('error').message, /No game/);
  lobbies.createLobby('x', host, '   ');
  assert.match(host.last('error').message, /name/);

  lobbies.createLobby('host', host, 'Host');
  const { code } = host.last('lobby').lobby;
  const ids = Array.from({ length: lobbies.MAX_PLAYERS - 1 }, (_, i) => `p${i}`);
  for (const id of ids) lobbies.joinLobby(id, fakeSocket(), code, id);
  const late = fakeSocket();
  lobbies.joinLobby('late', late, code, 'Late');
  assert.match(late.last('error').message, /full/);
  leaveAll('host', ...ids);
});

test('host passes on when the host leaves, and empty lobbies close', () => {
  const a = fakeSocket();
  const b = fakeSocket();
  lobbies.createLobby('a', a, 'A');
  const { code } = a.last('lobby').lobby;
  lobbies.joinLobby('b', b, code, 'B');

  lobbies.leaveLobby('a');
  assert.equal(a.last('lobby').lobby, null);
  assert.equal(b.last('lobby').lobby.hostId, 'b');

  lobbies.leaveLobby('b');
  const c = fakeSocket();
  lobbies.joinLobby('c', c, code, 'C');
  assert.match(c.last('error').message, /No game/);
});

test('the host starts a game for everyone; late joiners wait for the next one', () => {
  const a = fakeSocket();
  const b = fakeSocket();
  lobbies.createLobby('a', a, 'A');
  const { code } = a.last('lobby').lobby;
  lobbies.joinLobby('b', b, code, 'B');

  lobbies.startGame('b', 1); // not the host: ignored
  assert.equal(a.last('game'), undefined);

  lobbies.startGame('a', 7);
  for (const socket of [a, b]) {
    const game = socket.last('game');
    assert.equal(game.seed, 7);
    assert.equal(game.players.length, 2);
  }
  assert.equal(b.last('game').you, 'b');
  const [pa, pb] = a.last('game').players;
  assert.ok(pa.x !== pb.x || pa.y !== pb.y, 'players spawn on different tiles');

  const c = fakeSocket();
  lobbies.joinLobby('c', c, code, 'C');
  const lobby = c.last('lobby').lobby;
  assert.equal(lobby.phase, 'playing');
  assert.deepEqual(lobby.players.map((p) => p.inGame), [true, true, false]);
  assert.equal(c.last('game'), undefined);

  lobbies.endGame('a');
  assert.equal(c.last('lobby').lobby.phase, 'lobby');
  leaveAll('a', 'b', 'c');
});

test('a dropped player keeps their place and is put back on reconnect', () => {
  const a = fakeSocket();
  lobbies.createLobby('a', a, 'A');
  const { code } = a.last('lobby').lobby;
  lobbies.joinLobby('b', fakeSocket(), code, 'B');
  lobbies.startGame('a', 3);

  lobbies.disconnect('b');
  let lobby = a.last('lobby').lobby;
  assert.deepEqual(lobby.players.map((p) => [p.connected, p.inGame]), [[true, true], [false, true]]);

  const b2 = fakeSocket();
  lobbies.connect('b', b2);
  assert.equal(b2.messages[0].type, 'lobby');
  assert.equal(b2.last('game').seed, 3);
  lobby = a.last('lobby').lobby;
  assert.ok(lobby.players.every((p) => p.connected));
  leaveAll('a', 'b');
});

test('a player who stays away past the grace period is removed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakeSocket();
  lobbies.createLobby('a', a, 'A');
  lobbies.joinLobby('b', fakeSocket(), a.last('lobby').lobby.code, 'B');

  lobbies.disconnect('a');
  t.mock.timers.tick(60_000);
  const reconnected = fakeSocket();
  lobbies.connect('a', reconnected);
  assert.equal(reconnected.last('lobby').lobby, null);
  leaveAll('b');
});

test('inputs move players, and everyone sees the result', () => {
  const game = new Game(5, ['a', 'b']);
  const a = fakeSocket();
  const b = fakeSocket();
  game.connect('a', a);
  game.connect('b', b);
  const start = a.last('game').players.find((p) => p.id === 'a');

  for (let seq = 1; seq <= 6; seq++) game.queueInput('a', { seq, keys: KEY.RIGHT });
  game.queueInput('a', { seq: 3, keys: KEY.RIGHT }); // out of order: dropped
  game.lastTick -= 1000; // pretend time has passed so the inputs fit the budget
  game.tick();
  game.stop();

  assert.equal(a.last('state').ack, 6);
  const moved = b.last('state').players.find((p) => p.id === 'a');
  assert.ok(Math.abs(moved.x - start.x - 6 * PLAYER_SPEED * SIM_STEP) < 1e-9);
  assert.equal(moved.y, start.y);
});
