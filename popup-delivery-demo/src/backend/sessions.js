// Session registry — created by the REST handshake, referenced by every
// subsequent event and by the Real-time Server when a socket connects.
const { randomUUID } = require('crypto');
const bus = require('../bus');

const sessions = new Map();

function create({ userId, testUser = null, testScenario = null, userAgent = null }) {
  const session = {
    sessionId: randomUUID(),
    userId,
    testUser,
    testScenario,
    userAgent,
    startedAt: Date.now(),
    eventCount: 0,
  };
  sessions.set(session.sessionId, session);
  bus.trace('api', `Session created for ${userId}`, {
    sessionId: session.sessionId,
    testUser,
    testScenario,
  });
  return session;
}

module.exports = {
  create,
  get: (sessionId) => sessions.get(sessionId) || null,
  list: () => [...sessions.values()],
  clear: () => sessions.clear(),
};
