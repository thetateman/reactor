import { REACTOR_OVERHEAT_MIN, REACTOR_POWER_MIN } from './constants.js';

// Reactor state is { temperature, rodIn }: temperature from 0 (cold) to 100
// (meltdown), and whether the fuel rod is inserted.

export function isPowered(temperature) {
  return temperature >= REACTOR_POWER_MIN;
}

// 'cold' (blue, no power), 'stable' (green) or 'overheating' (red).
export function reactorZone(temperature) {
  if (temperature < REACTOR_POWER_MIN) return 'cold';
  return temperature < REACTOR_OVERHEAT_MIN ? 'stable' : 'overheating';
}
