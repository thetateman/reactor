import { SIM_STEP } from '/shared/constants.js';
import { playSound } from './audio.js';
import { ClientGame } from './game.js';
import { onKey, queuePickup, queueShot, sampleInput } from './input.js';
import { connect, on, send } from './net.js';
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
});

let you = null;
let lobby = null; // lobby summary from the server, or null when not in one
let roster = new Map(); // player id -> { name, color, connected, ... }
let game = null;
let menuOpen = false;
let latency = null;
let replaced = false;

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
  game = new ClientGame(msg, { onFire });
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

// Left click: shoot from our (predicted) position toward the clicked point.
// Right click on a pickup within reach: take it.
canvas.addEventListener('mousedown', (event) => {
  if (!game || menuOpen) return;
  const target = renderer.screenToWorld(event.clientX, event.clientY);
  if (!target) return;
  if (event.button === 0) {
    queueShot(Math.atan2(target.y - game.self.y, target.x - game.self.x));
  } else if (event.button === 2) {
    const item = game.pickupAt(target.x, target.y);
    if (item && game.inReach(item) && game.canTake(item)) {
      queuePickup(item.id);
      playSound('pickupAmmo'); // the server makes the same checks, so this will succeed
    }
  }
});

// Right click is for picking things up, not the browser's menu.
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
  const screen = !lobby ? 'home' : game ? 'game' : 'lobby';
  ui.show(screen);
  if (screen === 'lobby') ui.renderLobby(lobby, you);
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
    const { keys, aim, pickup } = sampleInput();
    game?.step(menuOpen ? 0 : keys, aim, pickup);
    acc -= SIM_STEP;
  }

  if (game) {
    renderer.draw(game, roster, acc / SIM_STEP, now);
    ui.renderAmmo(game.ammoLeft);
  } else {
    renderer.clear();
  }
  requestAnimationFrame(frame);
}

setInterval(() => send('ping', { t: performance.now() }), 2000);
requestAnimationFrame(frame);
start();
