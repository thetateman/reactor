# Reactor

A multiplayer browser game.

## Running

```sh
npm install
npm run dev      # restarts the server on changes to server/ or shared/
npm start        # plain run
npm test         # map generation and movement tests
```

Then open http://localhost:3000. Client changes only need a browser refresh; after a server restart the page reconnects on its own.

Controls: <kbd>WASD</kbd> or arrow keys to move, <kbd>E</kbd> to open or close a nearby door, <kbd>N</kbd> for a new map.

The current map's seed is shown in the HUD and kept in the URL (`?seed=123`), so reloading or sharing the link gives the same map.

Environment variables (all optional in development):

| Variable         | Default              |
| ---------------- | -------------------- |
| `PORT`           | `3000`               |
| `SESSION_SECRET` | `reactor-dev-secret` |

## Layout

```
server/
  index.js         Express app, sessions, WebSocket server
  game.js          A running match: applies player inputs, broadcasts state
  mapgen.js        Procedural map generation from a seed
  rng.js           Seeded random numbers
shared/            Imported by both server and browser (served at /shared)
  constants.js     Tick rates, player size and speed, tile and input codes
  map.js           Map data helpers: solidity, doors
  physics.js       Player movement and wall collision
public/            Static client (served as-is, no build step)
  js/main.js       Entry point: connection, game loop
  js/game.js       Client game state and movement prediction
  js/render.js     Canvas drawing and minimap
  js/input.js      Keyboard handling
  js/net.js        WebSocket wrapper (JSON messages keyed by `type`)
test/              node:test suites
docs/              Planning and design docs
```
