// Sound effects through the Web Audio API, plus looping background music.
// Each effect is decoded once, and every play gets its own source node, so
// rapid shots can overlap.

const SOUNDS = {
  gunshot: '/assets/single-pistol-gunshot.wav',
  doorOpen: '/assets/door-open.wav',
  doorClose: '/assets/door-close.wav',
  pickupAmmo: '/assets/pickup-ammo.wav',
};
const MASTER_VOLUME = 0.5; // the gunshot peaks at full scale; leave headroom for overlaps

// The music is minutes long, so it streams through an <audio> element rather
// than being decoded into memory. It fades in and out, so the loop is seamless.
const MUSIC_URL = '/assets/ambient.webm';
const MUSIC_VOLUME = 0.3; // background level, under the effects

const context = new AudioContext();
const master = context.createGain();
master.gain.value = MASTER_VOLUME;
master.connect(context.destination);

const buffers = new Map();
for (const [name, url] of Object.entries(SOUNDS)) {
  fetch(url)
    .then((res) => res.arrayBuffer())
    .then((data) => context.decodeAudioData(data))
    .then((buffer) => buffers.set(name, buffer))
    .catch((err) => console.warn(`Could not load sound "${name}":`, err));
}

const music = new Audio(MUSIC_URL);
music.loop = true;
music.volume = MUSIC_VOLUME;
music.preload = 'auto';

// Browsers block audio until the user interacts with the page, so effects
// are enabled and the music starts on the first click or key press. If the
// browser still refuses, the next interaction tries again.
function unlock() {
  context.resume();
  if (music.paused) music.play().catch(() => {});
}
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// Plays a sound at `volume` (0..1), `delay` seconds from now. Does nothing
// if it hasn't loaded yet.
export function playSound(name, { volume = 1, delay = 0 } = {}) {
  const buffer = buffers.get(name);
  if (!buffer || context.state !== 'running') return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  const gain = context.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(master);
  source.start(context.currentTime + Math.max(0, delay));
}
