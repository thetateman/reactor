import { SIM_STEP } from '/shared/constants.js';
import { ClientGame } from './game.js';
import { onKey, sampleKeys } from './input.js';
import { connect, on, send } from './net.js';
import { createRenderer } from './render.js';

const MAX_FRAME_TIME = 0.25; // seconds; avoids a burst of steps after the tab was hidden

const $ = (id) => document.getElementById(id);
const renderer = createRenderer($('view'));

let game = null;
let latency = null;

on('game', (msg) => {
  game = new ClientGame(msg);
  renderer.setMap(game.map);
  history.replaceState(null, '', `?seed=${msg.seed}`);
  updateHud();
});

on('state', (msg) => game?.applyState(msg));
on('door', (msg) => game?.applyDoor(msg));

on('pong', ({ t }) => {
  latency = Math.round(performance.now() - t);
  updateHud();
});

on('close', () => {
  game = null;
  $('overlay').hidden = false;
  setTimeout(start, 1000);
});

// N: new random map. Input stops until the server sends the new game.
onKey('KeyN', () => {
  game = null;
  send('newGame');
});

function seedFromUrl() {
  const seed = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isInteger(seed) && seed > 0 ? seed : undefined;
}

function updateHud() {
  const seed = game ? `seed ${game.seed}` : 'loading…';
  $('hud-info').textContent = `${seed} · ${latency ?? '–'} ms`;
}

// Connects (or reconnects after a server restart) and rejoins the map in the URL.
async function start() {
  try {
    await connect();
    $('overlay').hidden = true;
    send('newGame', { seed: seedFromUrl() });
  } catch {
    setTimeout(start, 1000);
  }
}

let acc = 0;
let last = performance.now();

function frame(now) {
  acc += Math.min((now - last) / 1000, MAX_FRAME_TIME);
  last = now;
  while (acc >= SIM_STEP) {
    const keys = sampleKeys();
    game?.step(keys);
    acc -= SIM_STEP;
  }

  if (game) renderer.draw(game, acc / SIM_STEP);
  else renderer.clear();
  requestAnimationFrame(frame);
}

setInterval(() => send('ping', { t: performance.now() }), 2000);
requestAnimationFrame(frame);
start();
