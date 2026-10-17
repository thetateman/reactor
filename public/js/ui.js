// DOM screens around the game canvas: home (create / join), lobby, in-game
// HUD and menu, level results, and a full-screen overlay for connection problems.

import { PLAYER_MAX_AMMO, PLAYER_MAX_HP } from '/shared/constants.js';
import { loadPref, savePref } from './prefs.js';

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

    // results: { time, players: [{ id, name, color, escaped, hp, down }] }
    renderResults(results, you) {
      const minutes = Math.floor(results.time / 60);
      const seconds = String(Math.floor(results.time % 60)).padStart(2, '0');
      $('results-time').textContent = `${minutes}:${seconds}`;
      const escapedFirst = [...results.players].sort((a, b) => b.escaped - a.escaped);
      $('results-players').replaceChildren(...escapedFirst.map((p) => resultItem(p, you)));
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

function resultItem(player, you) {
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
