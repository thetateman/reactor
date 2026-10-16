import { KEY } from '/shared/constants.js';

const MOVEMENT = {
  KeyW: KEY.UP,
  ArrowUp: KEY.UP,
  KeyS: KEY.DOWN,
  ArrowDown: KEY.DOWN,
  KeyA: KEY.LEFT,
  ArrowLeft: KEY.LEFT,
  KeyD: KEY.RIGHT,
  ArrowRight: KEY.RIGHT,
};

const actions = new Map();
let held = 0;
let interactPressed = false;

// Registers a one-shot handler for a key press (ignores auto-repeat).
export function onKey(code, handler) {
  actions.set(code, handler);
}

// Keys for the next movement step. Interact is reported once per press.
export function sampleKeys() {
  let keys = held;
  if (interactPressed) {
    keys |= KEY.INTERACT;
    interactPressed = false;
  }
  return keys;
}

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const bit = MOVEMENT[event.code];
  if (bit) {
    held |= bit;
    event.preventDefault();
    return;
  }

  if (event.repeat) return;
  if (event.code === 'KeyE') interactPressed = true;
  actions.get(event.code)?.();
});

window.addEventListener('keyup', (event) => {
  const bit = MOVEMENT[event.code];
  if (bit) held &= ~bit;
});

// Key-up events are lost while the window is unfocused, so release everything.
window.addEventListener('blur', () => {
  held = 0;
});
