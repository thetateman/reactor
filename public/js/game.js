import {
  AMMO_PICKUP, BULLET_RANGE, BULLET_SPEED, KEY, PLAYER_MAX_AMMO, PLAYER_MAX_HP,
} from '/shared/constants.js';
import { interactionTarget } from '/shared/interact.js';
import { castRay, deserializeMap } from '/shared/map.js';
import { stepPlayer } from '/shared/physics.js';
import { send } from './net.js';

// Other players and enemies are drawn this far (ms) behind the latest server
// state, so there are usually two snapshots to blend between.
const INTERPOLATION_DELAY = 100;
const SNAPSHOT_HISTORY = 1000;

// The client's view of a running game. Our own player is predicted: each input
// is applied locally right away and sent to the server. When the server reports
// where it has us, inputs it hasn't applied yet are replayed on top of that.
// Other players and enemies are interpolated between the snapshots the server sends.
//
// Bullets are animated locally from where and when they were fired. Our own
// appear the moment we click; the server later says where each one stopped.
export class ClientGame {
  // `onFire(bullet)` is called whenever a bullet starts, ours or anyone's,
  // with its origin and start time (`t0`, which may be slightly in the future).
  // `onTakeAmmo()` is called when we press E at an ammo stack we can take from,
  // and `onUseReactor()` when we press E beside the reactor.
  constructor(
    { seed, you, ammo, battery, map, players, enemies, pickups, reactor, lights, hallLights },
    { onFire, onTakeAmmo, onUseReactor } = {},
  ) {
    this.onFire = onFire ?? (() => {});
    this.onTakeAmmo = onTakeAmmo ?? (() => {});
    this.onUseReactor = onUseReactor ?? (() => {});
    this.seed = seed;
    this.you = you;
    this.map = deserializeMap(map);
    this.pickups = pickups; // [{ id, kind, x, y }]
    this.reactor = reactor; // { temperature, rodIn }, as of the last server update
    this.lights = lights; // lights[roomId]: whether that room is lit
    this.hallLights = hallLights; // whether the hallways are lit
    this.self = { x: 0, y: 0 };
    this.prev = { x: 0, y: 0 };
    this.hp = PLAYER_MAX_HP;
    this.down = false;
    this.ammo = ammo; // as of the last acknowledged input
    this.battery = battery; // seconds of flashlight left
    this.flashlightAcked = false; // our flashlight as of the last acknowledged input
    this.hurtAt = -Infinity; // performance.now() of the last HP loss
    // { time, others: Map<id, { x, y, hp, down, flashlight, aim }>, enemies: Map<id, { x, y, hp }> }, oldest first
    this.snapshots = [];
    // { id, seq, x, y, dx, dy, t0, maxDist }: origin, unit direction, fire time
    // and how far it flies. `id` is null until the server confirms our own shots.
    this.bullets = [];
    this.pending = [];
    this.seq = 0;
    this.applySnapshot(players, enemies);
    this.prev = { ...this.self };
  }

  // Our ammo once the server has applied our unacknowledged inputs, in the
  // same order it does: take ammo, then shoot.
  // Our flashlight with our unacknowledged toggles applied, the way the server will.
  get flashlightOn() {
    let on = this.flashlightAcked;
    for (const input of this.pending) {
      if (input.keys & KEY.FLASHLIGHT) on = !on && this.battery > 0;
    }
    return on && !this.down;
  }

  get ammoLeft() {
    let ammo = this.ammo;
    for (const input of this.pending) {
      if (input.tookAmmo) ammo = Math.min(PLAYER_MAX_AMMO, ammo + AMMO_PICKUP);
      if (input.keys & KEY.SHOOT) ammo--;
    }
    return ammo;
  }

  // What pressing E would do right now (see interactionTarget), or null.
  interactTarget() {
    return this.down ? null : interactionTarget(this.map, this.pickups, this.self, this.ammoLeft);
  }

  // Runs one fixed movement step with the given key bits, plus `aim` if shooting.
  step(keys, aim) {
    this.prev = { ...this.self };
    if (keys & KEY.SHOOT && this.ammoLeft <= 0) keys &= ~KEY.SHOOT;
    if (!keys || this.down) return;

    const input = { seq: ++this.seq, keys };
    stepPlayer(this.self, keys, this.map);
    // The server moves us and then handles E, so check the target from here.
    const target = keys & KEY.INTERACT ? this.interactTarget() : null;
    const tookAmmo = target?.kind === 'pickup';
    if (tookAmmo) this.onTakeAmmo();
    if (target?.kind === 'reactor') this.onUseReactor();
    if (keys & KEY.SHOOT) {
      input.aim = aim;
      this.addBullet({ seq: input.seq, x: this.self.x, y: this.self.y, dx: Math.cos(aim), dy: Math.sin(aim) }, performance.now());
    }
    this.pending.push({ ...input, tookAmmo });
    send('input', input);
  }

  applyState({ ack, ammo, battery, players, enemies, reactor, lights, hallLights }) {
    this.pending = this.pending.filter((input) => input.seq > ack);
    this.ammo = ammo;
    this.reactor = reactor;
    this.lights = lights;
    this.hallLights = hallLights;
    this.battery = battery;
    this.applySnapshot(players, enemies);
    // The server stops applying a downed player's movement, so don't replay it.
    if (this.down) this.pending = [];
    for (const input of this.pending) stepPlayer(this.self, input.keys, this.map);
  }

  // Returns the door that changed.
  applyDoor({ id, open }) {
    const door = this.map.doors[id];
    door.open = open;
    return door;
  }

  // A bullet was fired. Ours is already in flight, so just note its id. Other
  // players' bullets start INTERPOLATION_DELAY from now, when the drawn
  // (interpolated) shooter reaches the spot they fired from.
  applyShot({ id, owner, seq, x, y, dx, dy }) {
    const ours = owner === this.you && this.bullets.find((b) => b.id === null && b.seq === seq);
    if (ours) ours.id = id;
    else this.addBullet({ id, x, y, dx, dy }, performance.now() + INTERPOLATION_DELAY);
  }

  applyBulletEnd({ id, dist }) {
    const bullet = this.bullets.find((b) => b.id === id);
    if (bullet) bullet.maxDist = dist;
  }

  // Until the server says otherwise, a bullet flies to the first wall or closed door.
  addBullet({ id = null, seq = null, x, y, dx, dy }, t0) {
    const maxDist = castRay(this.map, x, y, dx, dy, BULLET_RANGE);
    const bullet = { id, seq, x, y, dx, dy, t0, maxDist };
    this.bullets.push(bullet);
    this.onFire(bullet);
  }

  // Bullets in flight as [{ x, y, dx, dy, flown }], dropping finished ones.
  bulletsAt(now) {
    this.bullets = this.bullets.filter((b) => BULLET_SPEED * (now - b.t0) / 1000 < b.maxDist);
    return this.bullets
      .filter((b) => now >= b.t0)
      .map((b) => {
        const flown = (BULLET_SPEED * (now - b.t0)) / 1000;
        return { x: b.x + b.dx * flown, y: b.y + b.dy * flown, dx: b.dx, dy: b.dy, flown };
      });
  }

  applySnapshot(players, enemies) {
    const now = performance.now();
    const others = new Map();
    for (const { id, x, y, hp, down, flashlight, aim } of players) {
      if (id === this.you) {
        this.self.x = x;
        this.self.y = y;
        if (hp < this.hp) this.hurtAt = now;
        this.hp = hp;
        this.down = down;
        this.flashlightAcked = flashlight;
      } else {
        others.set(id, { x, y, hp, down, flashlight, aim });
      }
    }

    this.snapshots.push({ time: now, others, enemies: new Map(enemies.map(({ id, ...enemy }) => [id, enemy])) });
    while (this.snapshots.length > 2 && this.snapshots[0].time < now - SNAPSHOT_HISTORY) {
      this.snapshots.shift();
    }
  }

  // Other players as [{ id, x, y, hp, down }], interpolated.
  othersAt(now) {
    return this.interpolate(now, 'others');
  }

  // Enemies as [{ id, x, y }], interpolated.
  enemiesAt(now) {
    return this.interpolate(now, 'enemies');
  }

  // Entities from snapshot field `field`, positioned between the two snapshots
  // around `now - INTERPOLATION_DELAY`. Other properties come from the newer one.
  interpolate(now, field) {
    const t = now - INTERPOLATION_DELAY;
    const snaps = this.snapshots;
    let i = 0;
    while (i + 1 < snaps.length && snaps[i + 1].time <= t) i++;
    const from = snaps[i];
    const to = snaps[i + 1];

    if (!to || t <= from.time) {
      return [...from[field]].map(([id, e]) => ({ id, ...e }));
    }
    const k = (t - from.time) / (to.time - from.time);
    return [...to[field]].map(([id, e]) => {
      const q = from[field].get(id) ?? e;
      return { ...e, id, x: q.x + (e.x - q.x) * k, y: q.y + (e.y - q.y) * k };
    });
  }

  // Our position for drawing, blended between the last two steps.
  selfAt(alpha) {
    return {
      x: this.prev.x + (this.self.x - this.prev.x) * alpha,
      y: this.prev.y + (this.self.y - this.prev.y) * alpha,
    };
  }
}
