# Reactor

A multiplayer browser game.

## Running

```sh
npm install
npm run dev      # restarts the server on changes to server/ or shared/
npm start        # plain run
npm test         # map generation and movement tests
```

Then open http://localhost:3000, enter a name and create a game. Share the four-letter code or the invite link (`/?lobby=CODE`); the host starts the game once everyone is in. Client changes only need a browser refresh.

Controls: <kbd>WASD</kbd> or arrow keys to move, left click to shoot toward the cursor, right click a nearby item (such as the ammo stack in the spawn room) to pick it up, <kbd>E</kbd> to open or close a nearby door, <kbd>Esc</kbd> for the menu (leave, or end the game for everyone if you're the host).

Players are identified by their session cookie, so:

- Refreshing the page, or a dropped connection, puts you back in your lobby and game. A disconnected player keeps their place for 60 seconds.
- To test with several players on one machine, use a separate browser or a private window for each. Tabs in the same browser are the same player; opening a second one takes over from the first.
- Lobbies live in server memory, so restarting the server (including `npm run dev` reloads) ends them.

Friends on your network can join at `http://<your-ip>:3000`.

Environment variables (all optional in development):

| Variable         | Default              |
| ---------------- | -------------------- |
| `PORT`           | `3000`               |
| `SESSION_SECRET` | `reactor-dev-secret` |

## Layout

```
server/
  index.js         Express app, sessions, WebSocket server, message routing
  lobby.js         Lobbies: codes, membership, host, reconnects, starting games
  game.js          A running match: player inputs, health, bullets, broadcasts state
  enemies.js       Enemy spawning and behavior (wander, chase on sight, search)
  mapgen.js        Procedural map generation from a seed
  rng.js           Seeded random numbers
shared/            Imported by both server and browser (served at /shared)
  constants.js     Tick rates, player size and speed, tile and input codes
  map.js           Map data helpers: solidity, doors, line of sight
  physics.js       Movement and wall collision
public/            Static client (served as-is, no build step)
  js/main.js       Entry point: connection, screen switching, game loop
  js/ui.js         Home, lobby and menu screens
  js/game.js       Client game state, movement prediction, interpolation
  js/render.js     Canvas drawing and minimap
  js/input.js      Keyboard and mouse handling
  js/audio.js      Sound effects (Web Audio)
  assets/          Sounds and other media
  js/net.js        WebSocket wrapper (JSON messages keyed by `type`)
test/              node:test suites
docs/              Planning and design docs
```
