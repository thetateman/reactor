import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { send } from './net.js';

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'reactor-dev-secret';
const ROOT = path.join(import.meta.dirname, '..');

const app = express();

// Shared between Express routes and the WebSocket upgrade handshake.
const sessionParser = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 },
});

app.use(express.json());
app.use(sessionParser);
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));

// Gives each browser a stable player id stored in its session.
// The client must call this before opening the WebSocket.
app.post('/api/session', (req, res) => {
  req.session.playerId ??= randomUUID();
  res.json({ playerId: req.session.playerId });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', onSocketError);

  sessionParser(req, {}, () => {
    if (!req.session.playerId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', (ws, req) => {
  const { playerId } = req.session;
  console.log(`player ${playerId} connected (${wss.clients.size} online)`);

  // Single player for now: each connection gets its own game.
  let game = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'newGame':
        game?.stop();
        game = new Game(parseSeed(msg.seed));
        game.addPlayer(playerId, ws);
        break;
      case 'input':
        game?.queueInput(playerId, msg);
        break;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;
    }
  });

  ws.on('close', () => {
    game?.stop();
    console.log(`player ${playerId} disconnected (${wss.clients.size} online)`);
  });
});

function parseSeed(seed) {
  return Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32 ? seed : randomInt(2 ** 32);
}

function onSocketError(err) {
  console.error(err);
}

server.listen(PORT, () => {
  console.log(`Reactor listening on http://localhost:${PORT}`);
});
