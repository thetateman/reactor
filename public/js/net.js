// Thin wrapper around the game WebSocket. Messages are JSON objects with a
// `type` field; register one handler per type with `on()`.

const handlers = new Map();
let socket;

export function on(type, handler) {
  handlers.set(type, handler);
}

export function send(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

// Establishes the session (sets the cookie the server checks on upgrade),
// then opens the WebSocket. Resolves with this player's id once connected.
export async function connect() {
  const res = await fetch('/api/session', { method: 'POST' });
  const { playerId } = await res.json();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handlers.get(msg.type)?.(msg);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  // Registered only once open, so a failed attempt rejects without also firing 'close'.
  socket.addEventListener('close', () => handlers.get('close')?.());
  return playerId;
}
