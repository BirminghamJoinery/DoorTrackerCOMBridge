// Regression tests for the packaged-app start-up crash
//   "Uncaught Exception: TypeError: Cannot read properties of null (reading
//    'catch') at Timeout._onTimeout"
// from the Temporary Data Matrix source's 5-minute timer,
// refresh('scheduled').catch(...).
//
// The cause: refresh() returned the shared `refreshing` variable, which its
// own .finally() resets to null. With no Server API URL or no access key the
// refresh needs no I/O and settles on microtasks alone, and Electron's main
// process can drain microtasks synchronously inside a native call (the
// webContents.send() that the status notification makes). The refresh then
// finished, and reset `refreshing` to null, before refresh() returned it.
// Plain Node never drains microtasks inside a synchronous call, so the
// crash tests re-create Electron's behaviour in a child Node process with
// V8's %PerformMicrotaskCheckpoint() (--allow-natives-syntax), called from
// the status callback exactly where webContents.send() sits in main.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempLabelSource, DEFAULT_REFRESH_INTERVAL_MS } = require('./source-cache');
const { fetchTempLabelSource } = require('../print-job-client');

const SOURCE_CACHE = require.resolve('./source-cache');
const PRINT_JOB_CLIENT = require.resolve('../print-job-client');

function tempDir() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'combridge-temp-refresh-'));
}

function memoryLogger() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function seedCache(cachePath) {
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    refreshedAt: new Date().toISOString(),
    sheetName: 'TEMP_LABELS',
    orders: { 5698: 4 },
    invalid: {}
  }));
}

// Runs the source with its REAL timer (start(), as main.js does) in a child
// process whose status callback drains microtasks synchronously, as
// Electron's webContents.send() can. Reports every refresh() return value,
// every uncaught exception, and how often the timer fired.
function runWithElectronLikeDrain(scenario) {
  const script = `
    const drainMicrotasks = new Function('%PerformMicrotaskCheckpoint()');
    const { createTempLabelSource } = require(${JSON.stringify(SOURCE_CACHE)});
    const { fetchTempLabelSource } = require(${JSON.stringify(PRINT_JOB_CLIENT)});
    const scenario = ${JSON.stringify(scenario)};
    const report = { uncaught: [], returns: [], fetches: 0, lookup: null, status: null };
    process.on('uncaughtException', (err) => report.uncaught.push(String(err && err.message)));
    const fetchRows = () => {
      report.fetches += 1;
      if (scenario.kind === 'ok') return Promise.resolve({ ok: true, rows: [{ row: 2, order: '5698', qty: '6' }], sheetName: 'TEMP_LABELS' });
      if (scenario.kind === 'fail') return Promise.resolve({ ok: false, error: 'Request timed out' });
      return fetchTempLabelSource(scenario.apiBase, scenario.accessKey); // no URL / no key: settles with no I/O
    };
    const source = createTempLabelSource({
      cachePath: scenario.cachePath,
      fetchRows,
      logger: { info() {}, warn() {}, error() {} },
      onStatus: () => drainMicrotasks() // where main.js calls webContents.send()
    });
    // Record what each refresh() returns, then call it exactly as the timer does.
    const original = source.refresh;
    source.refresh = (reason) => {
      const result = original(reason);
      report.returns.push(result && typeof result.then === 'function' ? 'promise' : String(result));
      return result;
    };
    // The same timer code main.js runs, at a test-sized interval.
    source.start(20);
    // A packaged-style one-off timer callback as well.
    setTimeout(() => source.refresh('scheduled').catch(() => {}), 5);
    setTimeout(() => {
      source.stop();
      report.lookup = source.lookup('5698');
      report.status = source.status();
      process.stdout.write(JSON.stringify(report));
    }, 150);
  `;
  const child = spawnSync(process.execPath, ['--allow-natives-syntax', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

// start()'s own timer calls refresh() internally, not through the recording
// wrapper, so only the one-off timer's call is recorded; the interval
// timer's firing shows in the fetch count instead.
function assertTimerSurvived(report) {
  assert.deepEqual(report.uncaught, [], 'no uncaught exception');
  assert.ok(report.returns.length >= 1);
  for (const r of report.returns) assert.equal(r, 'promise', 'refresh() always returns a promise');
  assert.ok(report.fetches >= 3, `the timer kept firing (${report.fetches} refreshes)`);
}

test('the drain helper really re-creates the crash: the old refresh() returned null under it', () => {
  // The pre-fix refresh(), verbatim, so this proves the test can see the bug.
  const script = `
    const drainMicrotasks = new Function('%PerformMicrotaskCheckpoint()');
    let refreshing = null;
    const notify = () => drainMicrotasks();
    async function doRefresh() { await Promise.resolve({ ok: false, error: 'No Server API URL configured.' }); return {}; }
    function refresh(reason = 'scheduled') {
      if (!refreshing) {
        refreshing = doRefresh(reason).finally(() => {
          refreshing = null;
          notify();
        });
        notify();
      }
      return refreshing;
    }
    setTimeout(() => {
      try { refresh('scheduled').catch(() => {}); process.stdout.write('no crash'); }
      catch (err) { process.stdout.write(err.message); }
    }, 1);
  `;
  const child = spawnSync(process.execPath, ['--allow-natives-syntax', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.stdout, "Cannot read properties of null (reading 'catch')");
});

test('start-up crash: no Server API URL - the 5-minute timer never throws, refresh() is always a promise', () => {
  const report = runWithElectronLikeDrain({ kind: 'real-fetch', apiBase: null, accessKey: 'k', cachePath: nodePath.join(tempDir(), 'c.json') });
  assertTimerSurvived(report);
  assert.equal(report.status.state, 'error');
  assert.equal(report.status.lastError, 'No Server API URL configured.');
});

test('start-up crash: no access key generated yet - no throw, the status says why', () => {
  const report = runWithElectronLikeDrain({ kind: 'real-fetch', apiBase: 'https://tracker.example', accessKey: null, cachePath: nodePath.join(tempDir(), 'c.json') });
  assertTimerSurvived(report);
  assert.match(report.status.lastError, /No website access key is set on this PC/);
  assert.equal(report.lookup.ok, false, 'no cache yet: nothing to print, but no crash');
});

test('start-up crash: no access key but cached data present - no throw, still prints from the cache', () => {
  const cachePath = nodePath.join(tempDir(), 'c.json');
  seedCache(cachePath);
  const report = runWithElectronLikeDrain({ kind: 'real-fetch', apiBase: 'https://tracker.example', accessKey: null, cachePath });
  assertTimerSurvived(report);
  assert.equal(report.status.state, 'cached', 'shown as using the cache');
  assert.deepEqual(report.lookup, { ok: true, qty: 4 });
});

test('start-up crash: failed and successful refreshes under the same conditions never throw either', () => {
  const failed = runWithElectronLikeDrain({ kind: 'fail', cachePath: nodePath.join(tempDir(), 'c.json') });
  assertTimerSurvived(failed);
  assert.equal(failed.status.lastError, 'Request timed out');

  const ok = runWithElectronLikeDrain({ kind: 'ok', cachePath: nodePath.join(tempDir(), 'c.json') });
  assertTimerSurvived(ok);
  assert.equal(ok.status.state, 'connected');
  assert.deepEqual(ok.lookup, { ok: true, qty: 6 });
});

// ---- the same conditions in-process, with the real timer and the real fetch client

async function runTimer({ fetchRows, cachePath }) {
  const source = createTempLabelSource({ cachePath, fetchRows, logger: memoryLogger() });
  source.start(10);
  await new Promise((resolve) => setTimeout(resolve, 80));
  source.stop();
  // stop() leaves at most one refresh in flight; wait for it.
  await source.refresh('manual');
  return source;
}

test('refresh() returns a promise in every state: idle, in flight, and right after finishing', async () => {
  const source = createTempLabelSource({ cachePath: nodePath.join(tempDir(), 'c.json'), logger: memoryLogger(), fetchRows: () => fetchTempLabelSource(null, null) });
  const first = source.refresh('manual');
  assert.equal(typeof first.then, 'function');
  assert.equal(source.refresh('manual'), first, 'an overlapping call shares the in-flight refresh');
  await first;
  const again = source.refresh('scheduled');
  assert.equal(typeof again.then, 'function');
  assert.notEqual(again, first);
  await again;
});

test('no API URL / no access key: the timer keeps running and the reason is reported', async () => {
  let calls = 0;
  const noUrl = await runTimer({ cachePath: nodePath.join(tempDir(), 'c.json'), fetchRows: () => { calls += 1; return fetchTempLabelSource(null, 'k'); } });
  assert.ok(calls >= 3, 'refreshed repeatedly');
  assert.equal(noUrl.status().lastError, 'No Server API URL configured.');

  const noKey = await runTimer({ cachePath: nodePath.join(tempDir(), 'c.json'), fetchRows: () => fetchTempLabelSource('https://tracker.example', null) });
  assert.match(noKey.status().lastError, /No website access key is set on this PC/);
  assert.equal(noKey.status().state, 'error');
});

test('failed refresh with cached data: the timer keeps running and printing uses the cache', async () => {
  const cachePath = nodePath.join(tempDir(), 'c.json');
  seedCache(cachePath);
  const source = await runTimer({ cachePath, fetchRows: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND' }) });
  assert.equal(source.status().state, 'cached');
  assert.equal(source.status().lastError, 'getaddrinfo ENOTFOUND');
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: 4 });
});

test('normal successful refresh on the timer; the production interval is still 5 minutes', async () => {
  let calls = 0;
  const source = await runTimer({ cachePath: nodePath.join(tempDir(), 'c.json'), fetchRows: async () => { calls += 1; return { ok: true, rows: [{ row: 2, order: '5698', qty: String(calls) }] }; } });
  assert.ok(calls >= 3);
  assert.equal(source.status().state, 'connected');
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: calls }, 'picks up the latest data');
  assert.equal(DEFAULT_REFRESH_INTERVAL_MS, 5 * 60 * 1000);
  const main = fs.readFileSync(nodePath.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on Windows CI
  assert.match(main, /\n\s+tempLabelSource\.start\(\);/, 'main.js starts it with the default (5-minute) interval');
});
