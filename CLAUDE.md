# Reactor

Multiplayer browser game. See README.md for running and layout; design docs live in `docs/`.

## Stack constraints

Keep the stack deliberately simple. Do not add frameworks, bundlers, TypeScript, or extra dependencies without asking first.

- Frontend: plain HTML, CSS, and vanilla JS as native ES modules, served statically from `public/`. No build step.
- Backend: Node, Express 5, express-session, ws. ES modules (`"type": "module"`).
- Code needed on both sides lives in `shared/`. The server imports it by relative path; the browser imports it from `/shared/...`.
- Tests use the built-in `node:test` runner (`npm test`).

## Architecture

- The server is authoritative. Clients only send input; the server owns positions, doors and all future game state.
- Movement runs in fixed steps (`SIM_STEP`). Each step with keys held, the client applies the input locally, sends it as `{ type: 'input', seq, keys }`, and keeps it until acknowledged. The server applies queued inputs on its tick (limited to real time) and replies with `{ type: 'state', ack, players }`; the client resets to the server position and replays inputs newer than `ack`.
- Because of that replay, `shared/physics.js` must stay deterministic: same inputs and map must give bit-identical positions on server and client.
- Other players and enemies are drawn about 100 ms in the past, interpolated between server snapshots (`ClientGame.interpolate`).
- Everything not driven by player input (the reactor, enemies, bullets, damage) advances in `Game.simulate(dt)`, called once per tick with a fixed `dt`; tests call it directly. Enemies exist only on the server and never collide with players, so client prediction stays exact.
- One-off actions ride the input stream so the server applies them at exactly the predicted position: `INTERACT` (the E key), `SHOOT` (the command also carries `aim`, in radians) and `FLASHLIGHT` (right-click toggle). What E does is decided by `interactionTarget` in `shared/interact.js` (hatch, then reactor, then usable pickup, then door), which the client also uses for its prompts, so they always agree. At the reactor, E just opens its menu on the client; the menu's Insert/Extract buttons send `{ type: 'reactor', action }`, which the server accepts only from a standing player within reach. Bullets aren't in state snapshots; the server sends `shot` when one is fired and `bulletEnd` with the distance it flew, and clients animate the straight-line flight themselves (the shooter's own bullet starts immediately, matched to the server's by `seq`).
- Per-player private values (currently `ammo`) go only in that player's own `state`/`game` message.
- Maps are mazes generated on the server from a seed (`server/mapgen.js`) and sent whole to the client. Everything downstream depends only on the map format documented in `shared/map.js` (tiles, rooms, doors, spawn room, reactor, exit), so the generator can change freely as long as it produces that.
- The reactor's state (`{ temperature, rodIn }`), the room lights (`lights[roomId]`) and the hallway light (`hallLights`), all on while there's power, are in every `state` message. Power and dial zones come from `shared/reactor.js`.
- Lighting is computed and drawn entirely in the browser (`public/js/lighting.js`, using the rays in `shared/vision.js`): the world is drawn as usual, then a darkness layer with lit rooms and lit hallways cut out entirely and other light (personal circle, flashlights, glows) cut out only where it's in the player's line of sight. The server only tracks what's switched on: room lights, each player's `flashlight` and `aim` (in the shared player list; clients send `{ type: 'aim', angle }` a few times a second), and their private `battery`.
- Each player's explored map lives only in their browser (`public/js/minimap.js`, saved in localStorage per game).
- Opening the exit hatch or a reactor meltdown ends the level: `Game` stops itself and calls its `onEnd` callback with `outcome: 'escaped' | 'meltdown'`, and the lobby keeps the results (with names) in its summary until the next game starts.
- `server/lobby.js` owns lobbies and membership; a lobby has at most one `Game` at a time, whose player list is fixed at start. Identity is the session's `playerId`: each player has one live socket (a new tab replaces the old), and on every connection the server sends `{ type: 'lobby', lobby }` (null if not in one), followed by `game` if they're playing, so reconnecting resumes play. Disconnected players keep their place for a grace period.
- The client picks its screen from that state alone: no lobby → home, lobby without a game → lobby screen, game → play.

## Conventions

- WebSocket messages are JSON objects with a `type` field, in both directions. The server dispatches on `msg.type` in `server/index.js`; the client registers handlers with `on(type, fn)` from `public/js/net.js`.
- The client must `POST /api/session` before opening the socket. The upgrade handler rejects connections whose session has no `playerId`.
- Sessions use the default in-memory store, so they reset whenever the server restarts.
- Positions and sizes are in tiles, not pixels; only `public/js/render.js` converts to pixels.
