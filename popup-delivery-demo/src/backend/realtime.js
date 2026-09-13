// Real-time Server (WebSocket).
//
// Holds the live socket registry keyed by sessionId and is the only component
// allowed to write to a browser socket. Actions produced for a session with no
// live socket are queued briefly and flushed on connect, so a campaign decided
// during the REST handshake is never lost.
const { WebSocketServer } = require('ws');
const bus = require('../bus');

const sockets = new Map(); // sessionId -> ws
const pending = new Map(); // sessionId -> message[]

let wss = null;

// Created in `noServer` mode: the HTTP server hosts two WebSocket endpoints
// (/ws for SDK clients, /ws/inspector for the flow inspector), so upgrade
// routing is done centrally in server.js rather than by path-matching here.
function attach({ onSessionOpen } = {}) {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      bus.trace('realtime', 'Rejected socket without sessionId');
      ws.close(4000, 'sessionId required');
      return;
    }

    sockets.set(sessionId, ws);
    bus.trace('realtime', `Socket open for session ${sessionId}`, {
      liveConnections: sockets.size,
    });

    ws.send(JSON.stringify({ type: 'connected', sessionId }));

    const queued = pending.get(sessionId) || [];
    if (queued.length) {
      bus.trace('realtime', `Flushing ${queued.length} queued message(s)`, { sessionId });
      for (const message of queued) ws.send(JSON.stringify(message));
      pending.delete(sessionId);
    }

    ws.on('close', () => {
      if (sockets.get(sessionId) === ws) sockets.delete(sessionId);
      bus.trace('realtime', `Socket closed for session ${sessionId}`, {
        liveConnections: sockets.size,
      });
    });

    if (onSessionOpen) onSessionOpen(sessionId);
  });

  return wss;
}

function handleUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

function sendToSession(sessionId, message) {
  const ws = sockets.get(sessionId);

  if (!ws || ws.readyState !== ws.OPEN) {
    const queue = pending.get(sessionId) || [];
    queue.push(message);
    pending.set(sessionId, queue);
    bus.trace('realtime', `No live socket — queued ${message.type}`, { sessionId });
    return { delivered: false, queued: true };
  }

  ws.send(JSON.stringify(message));
  bus.trace('realtime', `Pushed ${message.type} over WebSocket`, {
    sessionId,
    campaignId: message.campaignId,
  });
  return { delivered: true, queued: false };
}

function isConnected(sessionId) {
  const ws = sockets.get(sessionId);
  return Boolean(ws && ws.readyState === ws.OPEN);
}

function stats() {
  return { liveConnections: sockets.size, pendingSessions: pending.size };
}

function reset() {
  pending.clear();
}

module.exports = { attach, handleUpgrade, sendToSession, isConnected, stats, reset };
