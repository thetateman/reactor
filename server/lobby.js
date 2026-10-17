import { randomInt } from 'node:crypto';
import { Game } from './game.js';
import { send } from './net.js';

export const MAX_PLAYERS = 10;
const MAX_NAME_LENGTH = 16;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, which read like 1 and 0
const CODE_LENGTH = 4;
// How long a disconnected player keeps their place before being removed.
const RECONNECT_GRACE_MS = 60_000;

const COLORS = [
  '#3fb950', '#58a6ff', '#f778ba', '#a371f7', '#39c5cf',
  '#ff7b72', '#e6edf3', '#ffa657', '#c6e35b', '#6e7bff',
];

// A group of players who play together. Members persist across games: the host
// starts a game with everyone connected, and ending it returns all to the lobby.
// Players who join mid-game wait in the lobby until the next one. When a level
// is completed, its results stay on the lobby until the next game starts.
class Lobby {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.members = new Map(); // id -> { id, name, color, socket, leaveTimer }
    this.game = null;
    this.results = null; // { id, outcome, time, players: [{ id, name, color, escaped, hp, down }] }
    this.gamesPlayed = 0;
  }

  summary() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.game ? 'playing' : 'lobby',
      seed: this.game?.seed ?? null,
      results: this.results,
      players: [...this.members.values()].map(({ id, name, color, socket }) => ({
        id,
        name,
        color,
        connected: !!socket,
        inGame: !!this.game?.has(id),
      })),
    };
  }

  broadcast() {
    const lobby = this.summary();
    for (const member of this.members.values()) {
      if (member.socket) send(member.socket, { type: 'lobby', lobby });
    }
  }

  add(id, name, socket) {
    const used = new Set([...this.members.values()].map((m) => m.color));
    const color = COLORS.find((c) => !used.has(c));
    this.members.set(id, { id, name, color, socket, leaveTimer: null });
    this.hostId ??= id;
    this.broadcast();
  }

  remove(id) {
    const member = this.members.get(id);
    if (!member) return;
    clearTimeout(member.leaveTimer);
    this.members.delete(id);

    if (this.game) {
      this.game.removePlayer(id);
      if (this.game.size === 0) this.endGame();
    }
    if (this.hostId === id) this.hostId = this.members.keys().next().value ?? null;
    this.broadcast();
  }

  // Sends a (re)connecting member the lobby, then their game if they're in one.
  connect(id, socket) {
    const member = this.members.get(id);
    clearTimeout(member.leaveTimer);
    member.leaveTimer = null;
    member.socket = socket;
    this.broadcast();
    this.game?.connect(id, socket);
  }

  disconnect(id, onExpire) {
    const member = this.members.get(id);
    member.socket = null;
    member.leaveTimer = setTimeout(onExpire, RECONNECT_GRACE_MS);
    this.game?.disconnect(id);
    this.broadcast();
  }

  startGame(seed) {
    const connected = [...this.members.values()].filter((m) => m.socket);
    this.results = null;
    this.game = new Game(seed, connected.map((m) => m.id), { onEnd: (result) => this.finishGame(result) });
    this.broadcast();
    for (const member of connected) this.game.connect(member.id, member.socket);
  }

  // The level was completed (the game has already stopped itself).
  finishGame(result) {
    this.game = null;
    this.results = {
      id: ++this.gamesPlayed, // lets clients tell new results from ones they've dismissed
      outcome: result.outcome,
      time: result.time,
      players: result.players.map((p) => {
        const member = this.members.get(p.id);
        return { ...p, name: member?.name ?? 'Unknown', color: member?.color ?? null };
      }),
    };
    this.broadcast();
  }

  endGame() {
    this.game.stop();
    this.game = null;
  }
}

const lobbies = new Map(); // code -> Lobby
const lobbyOf = new Map(); // player id -> Lobby

// Called for every new connection. Rejoins the player's lobby (and game) if
// they still have a place in one, so a page refresh drops them back in.
export function connect(playerId, socket) {
  const lobby = lobbyOf.get(playerId);
  if (lobby) lobby.connect(playerId, socket);
  else send(socket, { type: 'lobby', lobby: null });
}

export function disconnect(playerId) {
  const lobby = lobbyOf.get(playerId);
  lobby?.disconnect(playerId, () => leaveLobby(playerId));
}

export function createLobby(playerId, socket, name) {
  const clean = cleanName(name);
  if (!clean) return sendError(socket, 'Enter a name first.');

  leaveLobby(playerId);
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (lobbies.has(code));

  const lobby = new Lobby(code);
  lobbies.set(code, lobby);
  lobbyOf.set(playerId, lobby);
  lobby.add(playerId, clean, socket);
}

export function joinLobby(playerId, socket, code, name) {
  const clean = cleanName(name);
  if (!clean) return sendError(socket, 'Enter a name first.');

  const lobby = lobbies.get(String(code).trim().toUpperCase());
  if (!lobby) return sendError(socket, `No game with code ${String(code).slice(0, CODE_LENGTH)}.`);
  if (lobbyOf.get(playerId) === lobby) return lobby.connect(playerId, socket);
  if (lobby.members.size >= MAX_PLAYERS) return sendError(socket, 'That game is full.');

  leaveLobby(playerId);
  lobbyOf.set(playerId, lobby);
  lobby.add(playerId, clean, socket);
}

export function leaveLobby(playerId) {
  const lobby = lobbyOf.get(playerId);
  if (!lobby) return;

  const { socket } = lobby.members.get(playerId);
  lobbyOf.delete(playerId);
  lobby.remove(playerId);
  if (socket) send(socket, { type: 'lobby', lobby: null });

  if (lobby.members.size === 0) lobbies.delete(lobby.code);
}

export function startGame(playerId, seed) {
  const lobby = lobbyOf.get(playerId);
  if (!lobby || lobby.hostId !== playerId || lobby.game) return;
  lobby.startGame(seed);
}

export function endGame(playerId) {
  const lobby = lobbyOf.get(playerId);
  if (!lobby || lobby.hostId !== playerId || !lobby.game) return;
  lobby.endGame();
  lobby.broadcast();
}

export function queueInput(playerId, msg) {
  lobbyOf.get(playerId)?.game?.queueInput(playerId, msg);
}

export function controlReactor(playerId, action) {
  lobbyOf.get(playerId)?.game?.controlReactor(playerId, action);
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  return name.replace(/\p{C}/gu, '').trim().slice(0, MAX_NAME_LENGTH) || null;
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}
