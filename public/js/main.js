import { SIM_STEP } from '/shared/constants.js';
import { playSound } from './audio.js';
import { ClientGame } from './game.js';
import { onKey, queueShot, sampleInput } from './input.js';
import { connect, on, send } from './net.js';
import { loadPref, savePref } from './prefs.js';
import { createRenderer } from './render.js';
import { createUi } from './ui.js';

const MAX_FRAME_TIME = 0.25; // seconds; avoids a burst of steps after the tab was hidden
const RECONNECT_DELAY = 1000;
// Sounds from elsewhere on the map are at full volume within this many tiles,
// then fall off with distance, down to a floor so they're always audible.
const SOUND_FULL_DISTANCE = 6;
const SOUND_MIN_VOLUME = 0.2;

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
const ui = createUi({
  create: (name) => send('createLobby', { name }),
  join: (code, name) => send('joinLobby', { code, name }),
  leave: () => send('leaveLobby'),
  start: () => send('startGame'),
  endGame: () => send('endGame'),
  resume: () => setMenu(false),
  reconnect: () => start(),
  dismissResults: () => {
    dismissedResults = lobby?.results?.id ?? null;
    updateScreen();
  },
});

let you = null;
let lobby = null; // lobby summary from the server, or null when not in one
let roster = new Map(); // player id -> { name, color, connected, ... }
let game = null;
let menuOpen = false;
let latency = null;
let replaced = false;
let dismissedResults = null; // id of the level results we've already closed
let showMinimap = loadPref('minimap', 'on') === 'on';

on('lobby', ({ lobby: next }) => {
  lobby = next;
  roster = new Map((lobby?.players ?? []).map((p) => [p.id, p]));
  if (lobby?.phase !== 'playing') game = null;
  history.replaceState(null, '', lobby ? `?lobby=${lobby.code}` : location.pathname);
  updateScreen();
});

on('game', (msg) => {
  // Timed to when each bullet appears on screen.
  const onFire = ({ x, y, t0 }) => playSoundAt('gunshot', x, y, (t0 - performance.now()) / 1000);
  // Only we hear ourselves take ammo; the server makes the same checks, so it will succeed.
  const onTakeAmmo = () => playSound('pickupAmmo');
  game = new ClientGame(msg, { onFire, onTakeAmmo });
  renderer.setMap(game.map);
  menuOpen = false;
  updateScreen();
});

on('state', (msg) => {
  if (!game) return;
  game.applyState(msg);
  ui.renderHealth(game.hp, game.down);
});
on('door', (msg) => {
  if (!game) return;
  const door = game.applyDoor(msg);
  playSoundAt(msg.open ? 'doorOpen' : 'doorClose', door.x + door.w / 2, door.y + door.h / 2);
});
on('shot', (msg) => game?.applyShot(msg));
on('bulletEnd', (msg) => game?.applyBulletEnd(msg));
on('error', ({ message }) => ui.showError(message));

on('pong', ({ t }) => {
  latency = Math.round(performance.now() - t);
  if (game) ui.renderHud(lobby, latency);
});

// Another tab connected as this player and took over.
on('replaced', () => {
  replaced = true;
});

on('close', () => {
  game = null;
  if (replaced) {
    ui.showOverlay('Reactor is open in another tab.', 'Play here');
  } else {
    ui.showOverlay('Disconnected — reconnecting…');
    setTimeout(start, RECONNECT_DELAY);
  }
});

onKey('Escape', () => {
  if (game) setMenu(!menuOpen);
});

// M: show or hide the minimap (remembered between visits).
onKey('KeyM', () => {
  showMinimap = !showMinimap;
  savePref('minimap', showMinimap ? 'on' : 'off');
});

// Left click: shoot from our (predicted) position toward the clicked point.
canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !game || menuOpen) return;
  const target = renderer.screenToWorld(event.clientX, event.clientY);
  if (target) queueShot(Math.atan2(target.y - game.self.y, target.x - game.self.x));
});

// Keep the browser's menu from popping up over the game on a stray right click.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// Plays a sound from a spot on the map, quieter the farther it is from us.
function playSoundAt(name, x, y, delay = 0) {
  const dist = Math.hypot(x - game.self.x, y - game.self.y);
  const volume = Math.min(1, Math.max(SOUND_MIN_VOLUME, SOUND_FULL_DISTANCE / dist));
  playSound(name, { volume, delay });
}

function setMenu(open) {
  menuOpen = open;
  updateScreen();
}

function updateScreen() {
  const newResults = lobby?.results && lobby.results.id !== dismissedResults;
  const screen = !lobby ? 'home' : game ? 'game' : newResults ? 'results' : 'lobby';
  ui.show(screen);
  if (screen === 'lobby') ui.renderLobby(lobby, you);
  if (screen === 'results') ui.renderResults(lobby.results, you);
  if (screen === 'game') {
    ui.renderHud(lobby, latency);
    ui.renderHealth(game.hp, game.down);
    ui.setMenu(menuOpen, lobby.hostId === you);
  }
}

// Connects, or reconnects after a drop. The server replies with our lobby (if
// we still have a place in one) and our game, so this also resumes play.
async function start() {
  replaced = false;
  try {
    you = await connect();
    ui.hideOverlay();
  } catch {
    ui.showOverlay('Disconnected — reconnecting…');
    setTimeout(start, RECONNECT_DELAY);
  }
}

let acc = 0;
let last = performance.now();

function frame(now) {
  acc += Math.min((now - last) / 1000, MAX_FRAME_TIME);
  last = now;
  while (acc >= SIM_STEP) {
    const { keys, aim } = sampleInput();
    game?.step(menuOpen ? 0 : keys, aim);
    acc -= SIM_STEP;
  }

  if (game) {
    renderer.draw(game, roster, acc / SIM_STEP, now, { minimap: showMinimap });
    ui.renderAmmo(game.ammoLeft);
  } else {
    renderer.clear();
  }
  requestAnimationFrame(frame);
}

setInterval(() => send('ping', { t: performance.now() }), 2000);
requestAnimationFrame(frame);
start();
