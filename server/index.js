import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import * as lobbies from './lobby.js';
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

// Each player (session) has at most one live connection. Opening the game in a
// second tab takes over from the first.
const sockets = new Map();

wss.on('connection', (ws, req) => {
  const { playerId } = req.session;
  console.log(`player ${playerId} connected (${wss.clients.size} online)`);

  const previous = sockets.get(playerId);
  if (previous) {
    send(previous, { type: 'replaced' });
    previous.close();
  }
  sockets.set(playerId, ws);
  lobbies.connect(playerId, ws);

  ws.on('message', (data) => {
    if (sockets.get(playerId) !== ws) return;

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'createLobby':
        lobbies.createLobby(playerId, ws, msg.name);
        break;
      case 'joinLobby':
        lobbies.joinLobby(playerId, ws, msg.code, msg.name);
        break;
      case 'leaveLobby':
        lobbies.leaveLobby(playerId);
        break;
      case 'startGame':
        lobbies.startGame(playerId, parseSeed(msg.seed));
        break;
      case 'endGame':
        lobbies.endGame(playerId);
        break;
      case 'input':
        lobbies.queueInput(playerId, msg);
        break;
      case 'reactor':
        lobbies.controlReactor(playerId, msg.action);
        break;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;
    }
  });

  ws.on('close', () => {
    console.log(`player ${playerId} disconnected (${wss.clients.size} online)`);
    if (sockets.get(playerId) !== ws) return;
    sockets.delete(playerId);
    lobbies.disconnect(playerId);
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
