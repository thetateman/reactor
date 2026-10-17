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
let shotAim = null; // angle of a click not yet sent, in radians
let flashlightToggled = false;

// Registers a one-shot handler for a key press (ignores auto-repeat). It's
// called with the keyboard event. If it returns true, the key's in-game
// meaning (E: interact) is skipped.
export function onKey(code, handler) {
  actions.set(code, handler);
}

// Fires on the next movement step, toward angle `aim`.
export function queueShot(aim) {
  shotAim = aim;
}

// Switches the flashlight on or off on the next movement step.
export function queueFlashlight() {
  flashlightToggled = true;
}

// Input for the next movement step: { keys, aim }. Interact, shots and
// flashlight toggles are reported once per press or click.
export function sampleInput() {
  let keys = held;
  let aim;
  if (interactPressed) {
    keys |= KEY.INTERACT;
    interactPressed = false;
  }
  if (shotAim !== null) {
    keys |= KEY.SHOOT;
    aim = shotAim;
    shotAim = null;
  }
  if (flashlightToggled) {
    keys |= KEY.FLASHLIGHT;
    flashlightToggled = false;
  }
  return { keys, aim };
}

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement) return; // typing a name or code

  const bit = MOVEMENT[event.code];
  if (bit) {
    held |= bit;
    event.preventDefault();
    return;
  }

  if (event.repeat) return;
  const handled = actions.get(event.code)?.(event);
  if (event.code === 'KeyE' && !handled) interactPressed = true;
});

window.addEventListener('keyup', (event) => {
  const bit = MOVEMENT[event.code];
  if (bit) held &= ~bit;
});

// Key-up events are lost while the window is unfocused, so release everything.
window.addEventListener('blur', () => {
  held = 0;
});
