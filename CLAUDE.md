# Reactor

Multiplayer browser game. See README.md for running and layout; design docs live in `docs/`.

## Stack constraints

Keep the stack deliberately simple. Do not add frameworks, bundlers, TypeScript, or extra dependencies without asking first.

- Frontend: plain HTML, CSS, and vanilla JS as native ES modules, served statically from `public/`. No build step.
- Backend: Node, Express 5, express-session, ws. ES modules (`"type": "module"`).
- Code needed on both sides lives in `shared/`. The server imports it by relative path; the browser imports it from `/shared/...`.
- Tests use the built-in `node:test` runner (`npm test`).

## Architecture

- The server is authoritative. Clients only send input; the server owns positions, doors and all future game state. Never send a client information its player shouldn't have (anything sent is readable in devtools).
- Movement runs in fixed steps (`SIM_STEP`). Each step with keys held, the client applies the input locally, sends it as `{ type: 'input', seq, keys }`, and keeps it until acknowledged. The server applies queued inputs on its tick (limited to real time) and replies with `{ type: 'state', ack, players }`; the client resets to the server position and replays inputs newer than `ack`.
- Because of that replay, `shared/physics.js` must stay deterministic: same inputs and map must give bit-identical positions on server and client.
- Maps are generated on the server from a seed (`server/mapgen.js`) and sent whole to the client.

## Conventions

- WebSocket messages are JSON objects with a `type` field, in both directions. The server dispatches on `msg.type` in `server/index.js`; the client registers handlers with `on(type, fn)` from `public/js/net.js`.
- The client must `POST /api/session` before opening the socket. The upgrade handler rejects connections whose session has no `playerId`.
- Sessions use the default in-memory store, so they reset whenever the server restarts.
- Positions and sizes are in tiles, not pixels; only `public/js/render.js` converts to pixels.
