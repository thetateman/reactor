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

Each level is a maze. Everyone starts with an empty gun in the control room in the middle, which has an ammo stack and the reactor. The goal is to find the exit hatch. Opening the hatch ends the level: every standing player in the extraction zone around it escapes, and a results screen shows the time, who escaped (with their HP) and who was left behind.

The reactor starts cold. Inserting its fuel rod heats it, and extracting the rod cools it at the same rate. Between 30% and 70% on its dial (green) it produces power; at 100% it melts down and everyone dies. Power turns on the lights in every room and hallway; without it the level is dark apart from a small circle around each player and their flashlight (10 minutes of battery). Tuning values are the `REACTOR_*` constants in `shared/constants.js` and `LIGHT` in `public/js/lighting.js`.

Controls: <kbd>WASD</kbd> or arrow keys to move, left click to shoot toward the cursor, right click to switch your flashlight on or off, <kbd>E</kbd> to use what's nearby (open the hatch when standing on it, open the reactor's controls, take ammo, or open/close a door), <kbd>M</kbd> to show or hide the minimap of what you've explored, <kbd>Shift</kbd>+<kbd>M</kbd> for the whole level (a testing aid), <kbd>Esc</kbd> for the menu (leave, or end the game for everyone if you're the host).

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
  game.js          A running match: player inputs, health, bullets, reactor, broadcasts state
  enemies.js       Enemy spawning and behavior (wander, chase on sight, search)
  mapgen.js        Maze generation from a seed: control room and reactor, chambers, exit hatch
  rng.js           Seeded random numbers
shared/            Imported by both server and browser (served at /shared)
  constants.js     Tick rates, player size and speed, tile and input codes
  map.js           Map data helpers: solidity, doors, line of sight
  interact.js      What E does where you stand (hatch, reactor, pickup or door)
  reactor.js       Reactor helpers: power and dial zones
  vision.js        Line-of-sight rays: what can be seen and lit from a point
  physics.js       Movement and wall collision
public/            Static client (served as-is, no build step)
  js/main.js       Entry point: connection, screen switching, game loop
  js/ui.js         Home, lobby, results and menu screens
  js/prefs.js      Per-browser settings (name, minimap, explored map)
  js/game.js       Client game state, movement prediction, interpolation
  js/render.js     Canvas drawing
  js/lighting.js   Darkness and light: what's lit and in sight each frame
  js/minimap.js    The player's explored-area minimap
  js/input.js      Keyboard and mouse handling
  js/audio.js      Sound effects (Web Audio)
  assets/          Sounds and other media
  js/net.js        WebSocket wrapper (JSON messages keyed by `type`)
test/              node:test suites
docs/              Planning and design docs
```
