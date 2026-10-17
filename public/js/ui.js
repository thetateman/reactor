// DOM screens around the game canvas: home (create / join), lobby, in-game
// HUD, menu and reactor controls, level results, and a full-screen overlay for
// connection problems.

import { PLAYER_MAX_AMMO, PLAYER_MAX_HP } from '/shared/constants.js';
import { reactorZone } from '/shared/reactor.js';
import { loadPref, savePref } from './prefs.js';
import { DIAL_EXTENT, drawDial } from './render.js';

const REACTOR_STATUS = {
  cold: 'Too cold: no power',
  stable: 'Stable: power on',
  overheating: 'Overheating!',
};

const $ = (id) => document.getElementById(id);

export function createUi(actions) {
  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    results: $('screen-results'),
    game: $('hud'),
  };

  $('name').value = loadPref('name', '');
  $('code').value = new URLSearchParams(location.search).get('lobby') ?? '';

  // Reads the name field, reporting an error if it's empty.
  function readName() {
    const name = $('name').value.trim();
    if (!name) {
      showError('Enter your name first.');
      $('name').focus();
      return null;
    }
    savePref('name', name);
    return name;
  }

  function join() {
    const code = $('code').value.trim().toUpperCase();
    if (!code) {
      showError('Enter the code of the game to join.');
      $('code').focus();
      return;
    }
    const name = readName();
    if (name) actions.join(code, name);
  }

  function create() {
    const name = readName();
    if (name) actions.create(name);
  }

  $('create').addEventListener('click', create);
  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    join();
  });
  $('name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ($('code').value.trim() ? join : create)();
  });

  $('copy-link').addEventListener('click', () => copyInviteLink());
  $('leave').addEventListener('click', () => actions.leave());
  $('start').addEventListener('click', () => actions.start());
  $('resume').addEventListener('click', () => actions.resume());
  $('end-game').addEventListener('click', () => actions.endGame());
  $('leave-game').addEventListener('click', () => actions.leave());
  $('overlay-button').addEventListener('click', () => actions.reconnect());
  $('results-continue').addEventListener('click', () => actions.dismissResults());
  $('reactor-insert').addEventListener('click', () => actions.reactor('insert'));
  $('reactor-extract').addEventListener('click', () => actions.reactor('extract'));

  function showError(message) {
    $('home-error').textContent = message;
    $('home-error').hidden = false;
  }

  return {
    showError,

    // screen: 'home' | 'lobby' | 'results' | 'game'
    show(screen) {
      for (const [name, el] of Object.entries(screens)) el.hidden = name !== screen;
      if (screen !== 'home') $('home-error').hidden = true;
      if (screen !== 'game') {
        $('menu').hidden = true;
        $('reactor-menu').hidden = true;
        $('down-notice').hidden = true;
      }
    },

    renderLobby(lobby, you) {
      const isHost = lobby.hostId === you;
      const playing = lobby.phase === 'playing';
      const inGame = lobby.players.some((p) => p.id === you && p.inGame);
      $('lobby-code').textContent = lobby.code;
      $('invite-link').value = `${location.origin}/?lobby=${lobby.code}`;
      $('lobby-players').replaceChildren(...lobby.players.map((p) => playerItem(p, lobby, you)));

      $('start').hidden = !isHost || playing;
      $('lobby-status').textContent =
        playing && inGame ? 'Starting…'
        : playing ? "A game is in progress. You'll join the next one."
        : isHost ? 'Share the code or link with friends, then start when everyone is in.'
        : 'Waiting for the host to start the game…';
    },

    // results: { outcome, time, players: [{ id, name, color, escaped, hp, down }] }
    renderResults(results, you) {
      const meltdown = results.outcome === 'meltdown';
      $('results-heading').textContent = meltdown ? 'Meltdown' : 'Level complete';
      $('results-heading').classList.toggle('error', meltdown);
      const minutes = Math.floor(results.time / 60);
      const seconds = String(Math.floor(results.time % 60)).padStart(2, '0');
      $('results-time').textContent = `${minutes}:${seconds}`;
      const escapedFirst = [...results.players].sort((a, b) => b.escaped - a.escaped);
      $('results-players').replaceChildren(...escapedFirst.map((p) => resultItem(p, you, meltdown)));
    },

    setReactorMenu(open) {
      $('reactor-menu').hidden = !open;
    },

    // Called every frame while the reactor menu is open.
    renderReactorMenu({ temperature, rodIn }) {
      const canvas = $('reactor-dial');
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      // Fit the whole dial, colored band included, with a little margin.
      const margin = 6;
      const r = Math.min(canvas.clientWidth / 2 - margin, canvas.clientHeight - 2 * margin) / DIAL_EXTENT;
      drawDial(ctx, canvas.clientWidth / 2, canvas.clientHeight - margin, r, temperature);

      const zone = reactorZone(temperature);
      const status = `${Math.round(temperature)}% · ${REACTOR_STATUS[zone]} · rod ${rodIn ? 'in, heating' : 'out, cooling'}`;
      if ($('reactor-status').textContent !== status) {
        $('reactor-status').textContent = status;
        $('reactor-status').className = `reactor-status ${zone}`;
      }
      $('reactor-insert').disabled = rodIn;
      $('reactor-extract').disabled = !rodIn;
    },

    renderPower(on) {
      const text = on ? 'on' : 'off';
      if ($('power-text').textContent === text) return; // called every frame
      $('power-text').textContent = text;
      $('power-text').classList.toggle('on', on);
    },

    renderHud(lobby, latency) {
      const ping = latency === null ? '–' : latency;
      $('hud-info').textContent = `game ${lobby.code} · seed ${lobby.seed} · ${ping} ms`;
    },

    renderHealth(hp, down) {
      const frac = Math.max(0, Math.min(1, hp / PLAYER_MAX_HP));
      $('health-fill').style.width = `${frac * 100}%`;
      $('health-fill').className = `health-fill ${frac > 0.5 ? '' : frac > 0.25 ? 'mid' : 'low'}`;
      $('health-text').textContent = `${Math.ceil(hp)}/${PLAYER_MAX_HP}`;
      $('down-notice').hidden = !down;
    },

    renderAmmo(ammo) {
      const text = ammo > 0 ? `${ammo}/${PLAYER_MAX_AMMO}` : 'empty';
      if ($('ammo-text').textContent === text) return; // called every frame
      $('ammo-text').textContent = text;
      $('ammo-text').classList.toggle('empty', ammo <= 0);
    },

    setMenu(open, isHost) {
      $('menu').hidden = !open;
      $('end-game').hidden = !isHost;
    },

    // Pass a button label to offer a manual retry instead of retrying automatically.
    showOverlay(text, buttonLabel) {
      $('overlay-text').textContent = text;
      $('overlay-button').hidden = !buttonLabel;
      $('overlay-button').textContent = buttonLabel ?? '';
      $('overlay').hidden = false;
    },

    hideOverlay() {
      $('overlay').hidden = true;
    },
  };
}

function resultItem(player, you, meltdown) {
  const li = document.createElement('li');
  li.classList.toggle('left-behind', !player.escaped);

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.setProperty('--color', player.color);

  const name = document.createElement('span');
  name.textContent = player.id === you ? `${player.name} (you)` : player.name;

  const outcome = document.createElement('span');
  outcome.className = 'tags';
  outcome.textContent = player.escaped
    ? `Escaped · ${player.hp}/${PLAYER_MAX_HP} HP`
    : meltdown ? 'Killed in the meltdown'
    : player.down ? 'Left behind (down)' : 'Left behind';

  li.append(swatch, name, outcome);
  return li;
}

function playerItem(player, lobby, you) {
  const li = document.createElement('li');
  li.classList.toggle('away', !player.connected);

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.setProperty('--color', player.color);

  const name = document.createElement('span');
  name.textContent = player.name;

  const tags = document.createElement('span');
  tags.className = 'tags';
  tags.textContent = [
    player.id === lobby.hostId && 'host',
    player.id === you && 'you',
    !player.connected && 'disconnected',
    lobby.phase === 'playing' && player.inGame && 'playing',
  ].filter(Boolean).join(' · ');

  li.append(swatch, name, tags);
  return li;
}

async function copyInviteLink() {
  const input = $('invite-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // The clipboard API needs a secure context (https or localhost); over a
    // plain-http LAN address, fall back to selecting the text.
    input.select();
    document.execCommand('copy');
  }
  $('copy-link').textContent = 'Copied';
  setTimeout(() => ($('copy-link').textContent = 'Copy link'), 1500);
}
