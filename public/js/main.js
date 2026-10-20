import { SIM_STEP } from '/shared/constants.js';
import { isPowered } from '/shared/reactor.js';
import { playSound } from './audio.js';
import { ClientGame } from './game.js';
import { onKey, queueFlashlight, queueShot, sampleInput } from './input.js';
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
// Our aim is sent this often at most, so teammates see where our flashlight points.
const AIM_SEND_MS = 100;
const AIM_SEND_CHANGE = 0.03; // radians

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
  reactor: (action) => send('reactor', { action }),
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
let reactorOpen = false; // the reactor's controls are showing
let fullMap = false; // Shift+M: the whole level instead of the minimap, for testing
let mouse = null; // last cursor position over the game, in client pixels
let aim = 0; // radians from us toward the cursor
let aimSent = { angle: null, at: 0 };

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
  const onUseReactor = () => setReactorMenu(true);
  game = new ClientGame(msg, { onFire, onTakeAmmo, onUseReactor });
  renderer.setMap(game.map, `${lobby?.code}:${msg.seed}`);
  menuOpen = false;
  reactorOpen = false;
  updateScreen();
});

on('state', (msg) => {
  if (!game) return;
  game.applyState(msg);
  ui.renderHealth(game.hp, game.down);
  if (game.down && reactorOpen) setReactorMenu(false);
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
  if (reactorOpen) setReactorMenu(false);
  else if (game) setMenu(!menuOpen);
});

// E closes the reactor's controls (and isn't sent as an interaction).
onKey('KeyE', () => {
  if (!reactorOpen) return false;
  setReactorMenu(false);
  return true;
});

// M: show or hide the minimap (remembered between visits).
// M: show or hide the minimap (remembered between visits). Shift+M: the whole
// level, for testing until the control-room computer exists.
onKey('KeyM', (event) => {
  if (event.shiftKey) {
    fullMap = !fullMap;
    return;
  }
  showMinimap = !showMinimap;
  savePref('minimap', showMinimap ? 'on' : 'off');
});

// Left click: shoot from our (predicted) position toward the clicked point.
// Left click: shoot toward the cursor. Right click: flashlight on or off.
canvas.addEventListener('mousedown', (event) => {
  mouse = { x: event.clientX, y: event.clientY };
  if (!game || menuOpen || reactorOpen) return;
  if (event.button === 0) {
    updateAim();
    queueShot(aim);
  } else if (event.button === 2) {
    queueFlashlight();
  }
});

canvas.addEventListener('mousemove', (event) => {
  mouse = { x: event.clientX, y: event.clientY };
});

// Points `aim` from our (predicted) position at the cursor, and tells the
// server when it has changed enough.
function updateAim() {
  const target = mouse && renderer.screenToWorld(mouse.x, mouse.y);
  if (!target) return;
  aim = Math.atan2(target.y - game.self.y, target.x - game.self.x);
  const now = performance.now();
  const turned = aimSent.angle === null || Math.abs(Math.atan2(Math.sin(aim - aimSent.angle), Math.cos(aim - aimSent.angle))) > AIM_SEND_CHANGE;
  if (turned && now - aimSent.at > AIM_SEND_MS) {
    send('aim', { angle: aim });
    aimSent = { angle: aim, at: now };
  }
}

// Keep the browser's menu from popping up over the game on a stray right click.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// Plays a sound from a spot on the map, quieter the farther it is from us.
function playSoundAt(name, x, y, delay = 0) {
  const dist = Math.hypot(x - game.self.x, y - game.self.y);
  const volume = Math.min(1, Math.max(SOUND_MIN_VOLUME, SOUND_FULL_DISTANCE / dist));
  playSound(name, { volume, delay });
}

// Standing at the reactor with its controls open: the player can't move or shoot.
function setReactorMenu(open) {
  reactorOpen = open;
  ui.setReactorMenu(open);
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
    ui.setReactorMenu(reactorOpen);
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
    game?.step(menuOpen || reactorOpen ? 0 : keys, aim);
    acc -= SIM_STEP;
  }

  if (game) {
    updateAim();
    renderer.draw(game, roster, acc / SIM_STEP, now, { aim, showMinimap, fullMap, showDial: game.reactor.used });
    ui.renderAmmo(game.ammoLeft);
    ui.renderPower(isPowered(game.reactor.temperature));
    ui.renderFlashlight(game.battery, game.flashlightOn);
    if (reactorOpen) ui.renderReactorMenu(game.reactor);
  } else {
    renderer.clear();
  }
  requestAnimationFrame(frame);
}

setInterval(() => send('ping', { t: performance.now() }), 2000);
requestAnimationFrame(frame);
start();
