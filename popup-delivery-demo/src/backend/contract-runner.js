// Runs the portable contract spec against this live server and reports the
// per-test verdicts.
//
// This is what lets the demo *prove* the contract rather than assert it: the
// button in Demo controls runs tests/popup-delivery.spec.ts — the same file
// CI runs — pointed at the very instance on screen, via BASE_URL. With
// BASE_URL set, playwright.config.ts skips the mock-only suites and starts no
// server of its own, so the run exercises the running app.
//
// The command is fixed. Nothing from the request reaches the child process
// argv or its environment, so the endpoint is not a shell surface. It is still
// a local demo tool: it spawns a browser run on request and is not meant to be
// exposed beyond localhost.
const { spawn } = require('child_process');
const path = require('path');
const bus = require('../bus');

const PROJECT_DIR = path.join(__dirname, '..', '..');
const CLI = path.join(PROJECT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
const SPEC = 'tests/popup-delivery.spec.ts';
const RUN_TIMEOUT_MS = 120_000;

let inFlight = null;

function parseReport(stdout) {
  // The JSON reporter writes one object to stdout; anything the toolchain
  // prints around it is ignored by slicing to the outermost braces.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let report;
  try {
    report = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }

  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      const result = (spec.tests || [])[0] || {};
      const attempt = (result.results || [])[0] || {};
      tests.push({
        title: spec.title,
        status: spec.ok ? 'passed' : attempt.status || 'failed',
        durationMs: attempt.duration ?? null,
        error: attempt.error ? String(attempt.error.message || '').split('\n')[0] : null,
      });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);

  return tests;
}

// Part 3 of the assignment: the submitted test and its rewrite, run against
// this instance so the code review is demonstrated rather than asserted.
// submitted.spec.ts is expected to fail — that is the deliverable — so it
// lives in its own suite and never gates anything.
const CODE_REVIEW = {
  config: 'playwright.code-review.config.ts',
  submitted: 'tests-code-review/submitted.spec.ts',
  rewritten: 'tests-code-review/rewritten.spec.ts',
};

function run(baseUrl, options = {}) {
  if (inFlight) return inFlight;

  const spec = options.spec || SPEC;
  const label = options.label || 'Contract';
  const args = [CLI, 'test', spec, '--reporter=json', '--workers=1'];
  if (options.config) args.push('--config=' + options.config);

  bus.trace('api', `${label} test run started`, { baseUrl, spec });

  inFlight = new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      args,
      {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          FORCE_COLOR: '0',
          PW_TEST_HTML_REPORT_OPEN: 'never',
        },
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    const killer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, error: 'Could not start Playwright: ' + err.message, tests: [] });
    });

    child.on('close', (code) => {
      clearTimeout(killer);
      const tests = parseReport(stdout);

      if (!tests) {
        resolve({
          ok: false,
          error: (stderr.trim() || 'Playwright produced no parsable report').split('\n')[0],
          tests: [],
        });
        return;
      }

      const passed = tests.filter((t) => t.status === 'passed').length;
      bus.trace('api', `${label} test run finished — ${passed}/${tests.length} passed`, {
        exitCode: code,
      });

      resolve({ ok: code === 0, passed, total: tests.length, tests });
    });
  }).finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = {
  run,
  isRunning: () => Boolean(inFlight),
  SPEC,
  CODE_REVIEW,
};
