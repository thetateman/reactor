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
let pickupId = null; // pickup right-clicked but not yet sent

// Registers a one-shot handler for a key press (ignores auto-repeat).
export function onKey(code, handler) {
  actions.set(code, handler);
}

// Fires on the next movement step, toward angle `aim`.
export function queueShot(aim) {
  shotAim = aim;
}

// Takes pickup `id` on the next movement step.
export function queuePickup(id) {
  pickupId = id;
}

// Input for the next movement step: { keys, aim, pickup }. Interact, shots and
// pickups are reported once per press or click.
export function sampleInput() {
  let keys = held;
  let aim;
  let pickup;
  if (interactPressed) {
    keys |= KEY.INTERACT;
    interactPressed = false;
  }
  if (shotAim !== null) {
    keys |= KEY.SHOOT;
    aim = shotAim;
    shotAim = null;
  }
  if (pickupId !== null) {
    keys |= KEY.PICKUP;
    pickup = pickupId;
    pickupId = null;
  }
  return { keys, aim, pickup };
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
