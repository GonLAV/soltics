// Solitics-style real-time campaign platform — single-process demo.
//
//   Client Browser  ──REST──▶  API Layer ──▶ Event Ingestion ──▶ User Profile
//        ▲                                          │              & Segmentation
//        │                                          ▼
//        └────WebSocket────  Real-time Server ◀── Campaign Engine
//                                                (rules → decision → action sender)
//
// One HTTP server hosts the static mock site, the REST API and both WebSocket
// endpoints (/ws for SDK clients, /ws/inspector for the flow dashboard).
const http = require('http');
const fs = require('fs');
const path = require('path');

const bus = require('./src/bus');
const api = require('./src/backend/api');
const realtime = require('./src/backend/realtime');
const inspector = require('./src/backend/inspector');
const { campaignManager } = require('./src/engine/campaign-manager');

const PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');

// The Playwright HTML report is build output, not a static asset, so it is
// mounted separately at /test-report/ — this keeps the whole submission
// (demo, dashboard, written answers, test results) on one origin.
const REPORT_DIR = path.join(__dirname, 'playwright-report');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  let root = PUBLIC_DIR;
  let relative;

  if (urlPath === '/test-report' || urlPath.startsWith('/test-report/')) {
    root = REPORT_DIR;
    const rest = urlPath.slice('/test-report'.length).replace(/^\/+/, '');
    relative = rest === '' ? 'index.html' : rest;
  } else {
    relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  }

  const filePath = path.join(root, relative);

  // Keep path traversal out of the static handler.
  if (!filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (root === REPORT_DIR) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<p style="font:14px system-ui;padding:40px">No test report yet. ' +
            'Run <code>npx playwright test</code> in <code>popup-delivery-demo</code>, ' +
            'then reload.</p>'
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const handled = await api.handle(req, res);
  if (!handled) serveStatic(req, res);
});

realtime.attach();
inspector.attach();

// Central upgrade routing — both WebSocket servers run in `noServer` mode.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/ws') return realtime.handleUpgrade(req, socket, head);
  if (pathname === '/ws/inspector') return inspector.handleUpgrade(req, socket, head);

  socket.destroy();
});

campaignManager.seed();

server.listen(PORT, () => {
  bus.trace('api', 'Backend started on port ' + PORT);
  console.log('');
  console.log('  Solitics-style campaign platform (demo)');
  console.log('  ---------------------------------------');
  console.log('  Customer website   http://localhost:' + PORT + '/');
  console.log('  Flow inspector     http://localhost:' + PORT + '/dashboard.html');
  console.log('  REST API           http://localhost:' + PORT + '/api/v1/health');
  console.log('  Real-time server   ws://localhost:' + PORT + '/ws');
  console.log('');
});

module.exports = server;
