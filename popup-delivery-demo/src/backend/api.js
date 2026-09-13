// API Layer — the REST endpoints the SDK and the dashboard talk to.
//
// Hand-rolled router so the demo keeps a zero web-framework dependency
// footprint. Every route answers JSON; thrown errors carry a `statusCode`.
const bus = require('../bus');
const sessions = require('./sessions');
const profiles = require('./profiles');
const ingestion = require('./ingestion');
const realtime = require('./realtime');
const { campaignManager } = require('../engine/campaign-manager');
const { campaignsDb, profilesDb, analyticsDb } = require('../db');
const contractRunner = require('./contract-runner');

const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Payload too large');
        error.statusCode = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error('Unknown sessionId — call /api/v1/sdk/init first');
    error.statusCode = 404;
    throw error;
  }
  return session;
}

const routes = [
  /* ---------------- SDK handshake ---------------- */
  {
    method: 'POST',
    path: '/api/v1/sdk/init',
    async handle(req, res, _params, body) {
      bus.trace('sdk', 'SDK initializing', { userId: body.userId });
      bus.trace('api', 'POST /api/v1/sdk/init', { userId: body.userId });

      if (!body.userId) {
        const error = new Error('userId is required');
        error.statusCode = 400;
        throw error;
      }

      // Test users are expressed as ordinary profile traits, so the rest of
      // the pipeline treats them like any real attribute.
      const traits = { ...(body.traits || {}) };
      if (body.testUser === 'non-eligible') traits.eligible = false;
      if (body.testUser === 'vip') traits.tier = 'vip';

      profiles.identify(body.userId, traits);

      const session = sessions.create({
        userId: body.userId,
        testUser: body.testUser || null,
        testScenario: body.testScenario || null,
        userAgent: req.headers['user-agent'] || null,
      });

      sendJson(res, 200, {
        ok: true,
        sessionId: session.sessionId,
        userId: session.userId,
        config: {
          wsPath: '/ws',
          eventsPath: '/api/v1/events',
        },
        profile: profilesDb.get(session.userId),
      });
    },
  },

  /* ---------------- Event intake ---------------- */
  {
    method: 'POST',
    path: '/api/v1/events',
    async handle(req, res, _params, body) {
      const session = requireSession(body.sessionId);
      const incoming = body.events || (body.event ? [body.event] : []);

      bus.trace('sdk', 'SDK sent ' + incoming.map((e) => '"' + (e && e.name) + '"').join(', '), {
        sessionId: session.sessionId,
      });
      bus.trace('api', 'POST /api/v1/events (' + incoming.length + ')', {
        sessionId: session.sessionId,
        names: incoming.map((e) => e && e.name),
      });

      if (incoming.length === 0) {
        const error = new Error('events[] or event is required');
        error.statusCode = 400;
        throw error;
      }

      const results = incoming.map((raw) => ingestion.ingest(raw, session));

      // The ack reports what the engine decided, which makes REST-only
      // assertions possible without opening a WebSocket.
      sendJson(res, 202, {
        ok: true,
        accepted: results.length,
        results: results.map((r) => ({
          eventId: r.event.eventId,
          name: r.event.name,
          delivered: r.delivered,
          decisions: r.decisions.map((d) => ({
            campaignId: d.campaignId,
            shouldTrigger: d.shouldTrigger,
            reasonCode: d.reasonCode,
            reason: d.reason,
          })),
        })),
      });
    },
  },

  /* ---------------- Campaign management ---------------- */
  {
    method: 'GET',
    path: '/api/v1/campaigns',
    async handle(req, res) {
      sendJson(res, 200, { ok: true, campaigns: campaignManager.list() });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/campaigns',
    async handle(req, res, _params, body) {
      let campaign;
      try {
        campaign = campaignManager.define(body);
      } catch (validationError) {
        validationError.statusCode = 400;
        throw validationError;
      }
      sendJson(res, 201, { ok: true, campaign });
    },
  },
  {
    method: 'PATCH',
    path: /^\/api\/v1\/campaigns\/([^/]+)\/status$/,
    async handle(req, res, params, body) {
      const campaign = campaignManager.setStatus(params[0], body.status);
      if (!campaign) {
        const error = new Error('Campaign not found');
        error.statusCode = 404;
        throw error;
      }
      sendJson(res, 200, { ok: true, campaign });
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/v1\/campaigns\/([^/]+)$/,
    async handle(req, res, params) {
      sendJson(res, 200, { ok: true, removed: campaignManager.remove(params[0]) });
    },
  },

  /* ---------------- Profiles, analytics, health ---------------- */
  {
    method: 'GET',
    path: '/api/v1/profiles',
    async handle(req, res) {
      sendJson(res, 200, { ok: true, profiles: profilesDb.list() });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/profiles\/([^/]+)$/,
    async handle(req, res, params) {
      const profile = profilesDb.get(decodeURIComponent(params[0]));
      if (!profile) {
        const error = new Error('Profile not found');
        error.statusCode = 404;
        throw error;
      }
      sendJson(res, 200, { ok: true, profile });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/analytics',
    async handle(req, res, _params, _body, url) {
      const limit = Number(url.searchParams.get('limit')) || 100;
      sendJson(res, 200, {
        ok: true,
        summary: analyticsDb.summary(),
        events: analyticsDb.list(limit),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/trace',
    async handle(req, res, _params, _body, url) {
      const limit = Number(url.searchParams.get('limit')) || 100;
      sendJson(res, 200, { ok: true, entries: bus.recent(limit) });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/health',
    async handle(req, res) {
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        campaigns: campaignsDb.list().length,
        profiles: profilesDb.list().length,
        sessions: sessions.list().length,
        realtime: realtime.stats(),
      });
    },
  },

  /* ---------------- Test / admin helpers ---------------- */
  {
    method: 'POST',
    path: '/api/v1/admin/reset',
    async handle(req, res) {
      profilesDb.clear();
      analyticsDb.clear();
      sessions.clear();
      realtime.reset();
      bus.clear();
      campaignManager.reset();
      bus.trace('api', 'State reset');
      sendJson(res, 200, { ok: true });
    },
  },

  // Runs the portable contract spec against this very instance, so the demo
  // can show the test passing rather than describe it.
  {
    method: 'POST',
    path: '/api/v1/qa/run-contract',
    async handle(req, res) {
      if (contractRunner.isRunning()) {
        sendJson(res, 409, { ok: false, error: 'A contract run is already in progress' });
        return;
      }

      const host = req.headers.host || 'localhost';
      const result = await contractRunner.run('http://' + host);
      sendJson(res, 200, { spec: contractRunner.SPEC, ...result });
    },
  },

  // Part 3 — runs the submitted test or its rewrite against this instance.
  // The submitted one is expected to fail; the failures are the deliverable.
  {
    method: 'POST',
    path: /^\/api\/v1\/qa\/code-review\/(submitted|rewritten)$/,
    async handle(req, res, params) {
      if (contractRunner.isRunning()) {
        sendJson(res, 409, { ok: false, error: 'A test run is already in progress' });
        return;
      }

      const which = params[0];
      const host = req.headers.host || 'localhost';
      const result = await contractRunner.run('http://' + host, {
        spec: contractRunner.CODE_REVIEW[which],
        config: contractRunner.CODE_REVIEW.config,
        label: 'Code review (' + which + ')',
      });

      sendJson(res, 200, {
        which,
        spec: contractRunner.CODE_REVIEW[which],
        expectedToFail: which === 'submitted',
        ...result,
      });
    },
  },
];

function match(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] };
    } else {
      const found = pathname.match(route.path);
      if (found) return { route, params: found.slice(1) };
    }
  }
  return null;
}

// Returns true when the request was an API request (handled or errored),
// false when it should fall through to the static file server.
async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (!url.pathname.startsWith('/api/')) return false;

  const found = match(req.method, url.pathname);
  if (!found) {
    sendJson(res, 404, { ok: false, error: 'No route for ' + req.method + ' ' + url.pathname });
    return true;
  }

  try {
    const body =
      req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT'
        ? await readJsonBody(req)
        : {};
    await found.route.handle(req, res, found.params, body, url);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    bus.trace('api', 'Error ' + statusCode + ': ' + error.message);
    if (!res.headersSent) sendJson(res, statusCode, { ok: false, error: error.message });
  }

  return true;
}

module.exports = { handle };
