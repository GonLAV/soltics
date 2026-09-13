// Internal trace bus.
//
// Every box in the architecture diagram reports what it did here. The flow
// inspector (public/dashboard.html) subscribes and draws the live path of a
// request through the system. Nothing in the delivery path depends on this —
// it is pure observability.
const { EventEmitter } = require('events');

const NODES = [
  'sdk',
  'api',
  'ingestion',
  'profile',
  'realtime',
  'campaign-manager',
  'rules',
  'decision',
  'action-sender',
  'campaigns-db',
  'profiles-db',
  'analytics-db',
];

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const history = [];
const HISTORY_LIMIT = 500;
let seq = 0;

function trace(node, message, data = {}) {
  const entry = {
    seq: ++seq,
    at: Date.now(),
    node,
    message,
    data,
  };
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
  emitter.emit('trace', entry);
  return entry;
}

module.exports = {
  NODES,
  trace,
  recent: (limit = 100) => history.slice(-limit),
  clear: () => {
    history.length = 0;
  },
  on: (listener) => {
    emitter.on('trace', listener);
    return () => emitter.off('trace', listener);
  },
};
