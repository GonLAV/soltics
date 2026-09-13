// Flow inspector channel — broadcasts every trace entry to dashboard clients.
//
// Observability only: it never touches the delivery path.
const { WebSocketServer } = require('ws');
const bus = require('../bus');

let wss = null;

function attach() {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'backlog', entries: bus.recent(80) }));
  });

  bus.on((entry) => {
    if (!wss) return;
    const frame = JSON.stringify({ type: 'trace', entry });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(frame);
    }
  });

  return wss;
}

function handleUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

module.exports = { attach, handleUpgrade };
