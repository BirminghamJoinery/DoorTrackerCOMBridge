// Temporary Data Matrix Printing: trigger parsing, T-code generation,
// quantity validation, the Google Sheet source cache, station mapping,
// printer selection, the ZPL Data Matrix label, duplicate suppression, batch
// ordering, and that existing scanning/printing/Remote Admin are untouched.
//
// No real printer, network, Google Sheet or Electron: the source fetch,
// printer status and raw submission are injected fakes; settings and the
// cache are real files in a temp folder. No label is ever printed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const codes = require('./codes');
const zpl = require('./zpl');
const settings = require('./settings');
const { createTempLabelSource, normalizeSourceRows, loadCache, STALE_AFTER_MS } = require('./source-cache');
const { createTempLabelTrigger, createSerialQueue, createPrinterCheck, tempJobName, DEFAULT_SUPPRESSION_MS } = require('./trigger');
const { createAccessKeyStore, sha256Hex } = require('./access-key');
const { runScanActions } = require('../scan-actions');
const printJobClient = require('../print-job-client');
const windowsPrinter = require('../printing/windows-printer');

const SRC = nodePath.join(__dirname, '..');
const read = (relative) => fs.readFileSync(nodePath.join(SRC, relative), 'utf8');

function tempDir() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'combridge-temp-labels-'));
}

function memoryLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(['INFO', m]),
    warn: (m) => lines.push(['WARN', m]),
    error: (m) => lines.push(['ERROR', m]),
    text: () => lines.map(([level, m]) => `${level} ${m}`).join('\n')
  };
}

// Pulls the encoded codes back out of a ZPL batch, in print order.
function encodedCodes(zplText) {
  return [...zplText.matchAll(/\^BX[^]*?\^FD([^^]*)\^FS/g)].map((m) => m[1]);
}

const STATION_NAMES = { joint_prehung: 'Pre-Hung', door_machining: 'Door CNC', joint_assembly: 'Assembly' };

// A trigger wired to a real settings file, an in-memory source and fake printers.
function harness({ stations, orders = { 5698: 4, '5626-2': 3 }, invalid = {}, printers, sendRaw, clock, queue } = {}) {
  const dir = tempDir();
  const settingsPath = nodePath.join(dir, 'temp-label-settings.json');
  if (stations) settings.saveTempLabelSettings(settingsPath, { stations, layout: settings.DEFAULT_LAYOUT });
  const logger = memoryLogger();
  const known = printers || { 'Zebra GK420D': 'ok', 'Zebra GK420D CNC': 'ok' };
  const calls = { status: [], sent: [], outcomes: [] };
  const time = clock || { now: 1_000_000 };
  const checkPrinter = createPrinterCheck(async (name) => {
    calls.status.push(name);
    const state = known[name];
    if (!state) return { supported: true, found: false, offline: false };
    return { supported: true, found: true, offline: state === 'offline', statusOffline: state === 'status-offline' };
  }, 'win32');

  const trigger = createTempLabelTrigger({
    getRule: (key) => settings.ruleForStation(settings.loadTempLabelSettings(settingsPath), key),
    lookupOrder: (order) => {
      if (Object.prototype.hasOwnProperty.call(orders, order)) return { ok: true, qty: orders[order] };
      if (invalid[order]) return { ok: false, reason: `Invalid temporary-label row: ${invalid[order]}` };
      return { ok: false, reason: 'Order not found in temporary-label source' };
    },
    getLayout: () => settings.loadTempLabelSettings(settingsPath).layout,
    checkPrinter,
    sendRaw: sendRaw || (async (printerName, buffer, options) => { calls.sent.push({ printerName, zpl: buffer.toString('ascii'), docName: options && options.docName }); }),
    logger,
    stationLabel: (key) => STATION_NAMES[key] || key,
    onOutcome: (o) => calls.outcomes.push(o),
    now: () => time.now,
    ...(queue ? { queue } : {})
  });
  return { trigger, settingsPath, logger, calls, time, orders };
}

const TWO_STATIONS = [
  { stationKey: 'joint_prehung', enabled: true, printerName: 'Zebra GK420D' },
  { stationKey: 'door_machining', enabled: true, printerName: 'Zebra GK420D CNC' },
  { stationKey: 'joint_assembly', enabled: false, printerName: '' }
];

async function scan(h, value, stationKey = 'joint_prehung', portPath = 'COM5') {
  const decision = h.trigger.handleScan({ value, stationKey, portPath });
  if (decision.done) await decision.done;
  return decision;
}

// ---------------------------------------------------------------- trigger parsing

test('general door codes trigger, with the order number (and any call-off) extracted', () => {
  assert.deepEqual(codes.parseTempLabelTrigger('5698-D'), { order: '5698' });
  assert.deepEqual(codes.parseTempLabelTrigger('5626-2-D'), { order: '5626-2' });
  assert.deepEqual(codes.parseTempLabelTrigger('5626-12-D'), { order: '5626-12' });
  assert.deepEqual(codes.parseTempLabelTrigger('  1234-d\r'), { order: '1234' }, 'trimmed and upper-cased');
});

test('unit, frame, delivery, temporary, bare and junk codes never trigger', () => {
  for (const code of ['5698-D-01', '5698-D-02', '5626-2-D-01', '5698-F', '5626-2-F', '5698-DELIV', '5698', '5698-T-01', 'ABC-D', '569-D', '56988-D', '5626-1234-D', 'random text', '', null, undefined, 5698]) {
    assert.equal(codes.parseTempLabelTrigger(code), null, String(code));
  }
});

// ---------------------------------------------------------------- code generation

test('codes are generated as order-T-NN in sequence', () => {
  assert.deepEqual(codes.generateTempCodes('5698', 3), ['5698-T-01', '5698-T-02', '5698-T-03']);
  assert.deepEqual(codes.generateTempCodes('5626-2', 2), ['5626-2-T-01', '5626-2-T-02']);
  assert.deepEqual(codes.generateTempCodes('5698', '1'), ['5698-T-01']);
});

test('two digits under 100, wider above, never truncated or duplicated', () => {
  assert.deepEqual([1, 9, 10, 99, 100, 200].map(codes.sequenceSuffix), ['01', '09', '10', '99', '100', '200']);
  const hundred = codes.generateTempCodes('5698', 100);
  assert.equal(hundred.length, 100);
  assert.equal(hundred[98], '5698-T-99');
  assert.equal(hundred[99], '5698-T-100');
  assert.equal(new Set(hundred).size, 100);
  assert.equal(codes.generateTempCodes('5626-12', 200)[199], '5626-12-T-200');
});

test('code generation refuses a bad order number or quantity', () => {
  assert.throws(() => codes.generateTempCodes('ABC', 2), /not a valid order number/);
  assert.throws(() => codes.generateTempCodes('5698-D', 2), /not a valid order number/);
  assert.throws(() => codes.generateTempCodes('5698', 0), /zero/);
  assert.throws(() => codes.generateTempCodes('5698', 201), /safety limit of 200/);
});

test('quantities: blank, text, fractions, zero, negative and over the limit are rejected', () => {
  for (const [raw, reason] of [['', /blank/], [null, /blank/], ['   ', /blank/], ['abc', /not a whole number/], ['2.5', /not a whole number/], ['4 labels', /not a whole number/], ['0', /zero/], ['-3', /negative/], ['- 3', /negative/], ['201', /safety limit/], ['999999', /safety limit/]]) {
    const result = codes.parseQuantity(raw);
    assert.equal(result.ok, false, String(raw));
    assert.match(result.reason, reason, String(raw));
  }
  assert.deepEqual(codes.parseQuantity(' 04 '), { ok: true, qty: 4 });
  assert.deepEqual(codes.parseQuantity('4.00'), { ok: true, qty: 4 });
  assert.deepEqual(codes.parseQuantity(12), { ok: true, qty: 12 });
  assert.deepEqual(codes.parseQuantity('200'), { ok: true, qty: 200 });
  assert.equal(codes.MAX_TEMP_LABELS_PER_SCAN, 200);
});

// ---------------------------------------------------------------- source / cache

function sourceHarness({ rows, fetchRows } = {}) {
  const dir = tempDir();
  const cachePath = nodePath.join(dir, 'temp-labels-cache.json');
  const logger = memoryLogger();
  const state = { rows: rows || [{ row: 2, order: '5698', qty: '4' }, { row: 3, order: '5626-2', qty: '3' }], fail: null, calls: 0 };
  const make = () => createTempLabelSource({
    cachePath,
    logger,
    fetchRows: fetchRows || (async () => {
      state.calls += 1;
      if (state.fail) return { ok: false, error: state.fail };
      return { ok: true, rows: state.rows, sheetName: 'TEMP_LABELS' };
    })
  });
  return { cachePath, logger, state, make };
}

test('a successful refresh fills the cache, saves it to disk and serves lookups', async () => {
  const h = sourceHarness();
  const source = h.make();
  assert.equal(source.status().state, 'empty');
  const status = await source.refresh('manual');
  assert.equal(status.state, 'connected');
  assert.equal(status.ordersCached, 2);
  assert.ok(status.lastSuccessAt);
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: 4 });
  assert.deepEqual(source.lookup('5626-2'), { ok: true, qty: 3 });
  assert.deepEqual(loadCache(h.cachePath).orders, { 5698: 4, '5626-2': 3 });
});

test('the cache survives a restart: lookups work before (and without) any refresh', async () => {
  const h = sourceHarness();
  await h.make().refresh('manual');
  h.state.fail = 'getaddrinfo ENOTFOUND';
  const afterRestart = h.make();
  assert.deepEqual(afterRestart.lookup('5698'), { ok: true, qty: 4 }, 'no network needed');
  assert.equal(afterRestart.status().state, 'cached');
  assert.equal(h.state.calls, 1, 'loading the cache made no request');
});

test('internet down: the last cache is kept (in memory and on disk) and the failure is shown and logged', async () => {
  const h = sourceHarness();
  const source = h.make();
  await source.refresh('manual');
  const fileBefore = fs.readFileSync(h.cachePath, 'utf8');
  h.state.fail = 'Request timed out';
  const status = await source.refresh('scheduled');
  assert.equal(status.state, 'cached');
  assert.equal(status.ordersCached, 2);
  assert.equal(status.lastError, 'Request timed out');
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: 4 });
  assert.equal(fs.readFileSync(h.cachePath, 'utf8'), fileBefore, 'cache file not erased');
  assert.match(h.logger.text(), /refresh failed \(scheduled\): Request timed out - still using cached data/);

  // a thrown fetch and a malformed response are failures too, never "empty sheet"
  const thrown = createTempLabelSource({ cachePath: h.cachePath, logger: memoryLogger(), fetchRows: async () => { throw new Error('boom'); } });
  assert.equal((await thrown.refresh()).state, 'cached');
  const malformed = createTempLabelSource({ cachePath: h.cachePath, logger: memoryLogger(), fetchRows: async () => ({ ok: true, rows: 'nope' }) });
  assert.equal((await malformed.refresh()).state, 'cached');
  assert.deepEqual(malformed.lookup('5698'), { ok: true, qty: 4 });
});

test('no cache and no internet fails safely: nothing to look up, a clear reason, status Error', async () => {
  const h = sourceHarness();
  h.state.fail = 'getaddrinfo ENOTFOUND';
  const source = h.make();
  const status = await source.refresh('start-up');
  assert.equal(status.state, 'error');
  assert.equal(status.ordersCached, 0);
  assert.match(source.lookup('5698').reason, /No temporary-label data has been downloaded yet/);
  assert.equal(fs.existsSync(h.cachePath), false);
  assert.match(h.logger.text(), /there is no cached data/);
});

test('a damaged or hand-edited cache file can never smuggle in a bad quantity', () => {
  const dir = tempDir();
  const p = nodePath.join(dir, 'temp-labels-cache.json');
  fs.writeFileSync(p, '{ not json');
  assert.equal(loadCache(p), null);
  fs.writeFileSync(p, JSON.stringify({ version: 1, refreshedAt: 'x', orders: { 5698: 5000, 1234: 3, 'ABC': 2, 5700: -1 }, invalid: {} }));
  assert.deepEqual(loadCache(p).orders, { 1234: 3 });
});

test('malformed quantities and order numbers are rejected per row and logged', async () => {
  const h = sourceHarness({
    rows: [
      { row: 2, order: '5698', qty: '4' },
      { row: 3, order: '5700', qty: '' },
      { row: 4, order: '5701', qty: 'lots' },
      { row: 5, order: '5702', qty: '0' },
      { row: 6, order: '5703', qty: '-2' },
      { row: 7, order: '5704', qty: '5000' },
      { row: 8, order: '01/02/5626', qty: '3' },
      { row: 9, order: '', qty: '' }
    ]
  });
  const source = h.make();
  const status = await source.refresh('manual');
  assert.equal(status.ordersCached, 1);
  assert.equal(status.invalidOrders, 5);
  assert.match(source.lookup('5700').reason, /Invalid temporary-label row: Quantity is blank/);
  assert.match(source.lookup('5701').reason, /not a whole number/);
  assert.match(source.lookup('5702').reason, /zero/);
  assert.match(source.lookup('5703').reason, /negative/);
  assert.match(source.lookup('5704').reason, /safety limit/);
  const log = h.logger.text();
  assert.match(log, /row\(s\) rejected/);
  assert.match(log, /Row: 8, Order: 01\/02\/5626, Reason: Order number is not in the 1234 or 1234-2 format/);
  assert.match(log, /Row: 7, Order: 5704, Reason: Quantity 5000 is above the safety limit/);
});

test('duplicate order rows are handled deterministically, whatever their order in the sheet', () => {
  const agree = [{ row: 2, order: '5698', qty: '4' }, { row: 9, order: ' 5698 ', qty: '04' }];
  assert.deepEqual(normalizeSourceRows(agree).orders, { 5698: 4 }, 'identical rows collapse');
  assert.deepEqual(normalizeSourceRows([...agree].reverse()).orders, { 5698: 4 });

  const disagree = [{ row: 2, order: '5698', qty: '4' }, { row: 9, order: '5698', qty: '6' }];
  for (const rows of [disagree, [...disagree].reverse()]) {
    const result = normalizeSourceRows(rows);
    assert.deepEqual(result.orders, {}, 'conflicting rows are not printable');
    assert.match(result.invalid['5698'], /appears 2 times with different quantities/);
  }
  const oneBad = normalizeSourceRows([{ row: 2, order: '5698', qty: '4' }, { row: 3, order: '5698', qty: 'x' }]);
  assert.deepEqual(oneBad.orders, {});
  assert.match(oneBad.invalid['5698'], /row 3; order appears 2 times/);
});

test('a manual refresh picks up sheet changes; overlapping refreshes make one request', async () => {
  const h = sourceHarness();
  const source = h.make();
  await source.refresh('start-up');
  h.state.rows = [{ row: 2, order: '5698', qty: '7' }];
  const [a, b] = await Promise.all([source.refresh('manual'), source.refresh('manual')]);
  assert.equal(a, b);
  assert.equal(h.state.calls, 2);
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: 7 });
  assert.match(source.lookup('5626-2').reason, /Order not found in temporary-label source/, 'removed rows are gone after a good refresh');
});

test('fetchTempLabelSource sends the access key as a Bearer token to GET /api/temp-labels (no real network)', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, auth: options.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ sheetName: 'TEMP_LABELS', rows: [{ row: 2, order: '5698', qty: '4' }] }) };
  });
  assert.deepEqual(await printJobClient.fetchTempLabelSource('https://example.test', 'the-key'), { ok: true, rows: [{ row: 2, order: '5698', qty: '4' }], sheetName: 'TEMP_LABELS' });
  assert.deepEqual(requests, [{ url: 'https://example.test/api/temp-labels', auth: 'Bearer the-key' }]);

  // no key on this PC: nothing is requested at all
  const noKey = await printJobClient.fetchTempLabelSource('https://example.test', null);
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /No website access key/);
  assert.equal(requests.length, 1);

  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'The temporary-label access key was not accepted.' }) }));
  assert.deepEqual(await printJobClient.fetchTempLabelSource('https://example.test', 'wrong'), { ok: false, error: 'The temporary-label access key was not accepted.' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  assert.equal((await printJobClient.fetchTempLabelSource('https://example.test', 'k')).ok, false);
  assert.equal((await printJobClient.fetchTempLabelSource(null, 'k')).ok, false);
});

test('a rejected key (401) keeps the cached data printing, like any other refresh failure', async () => {
  const h = sourceHarness();
  const source = h.make();
  await source.refresh('manual');
  h.state.fail = 'The temporary-label access key was not accepted.';
  const status = await source.refresh('scheduled');
  assert.equal(status.state, 'cached');
  assert.deepEqual(source.lookup('5698'), { ok: true, qty: 4 });
  assert.doesNotMatch(h.logger.text(), /Bearer/);
});

test('the cache warns when it is over 24 hours old, but lookups (printing) carry on', async () => {
  const dir = tempDir();
  const cachePath = nodePath.join(dir, 'temp-labels-cache.json');
  const clock = { now: new Date('2026-11-17T08:00:00Z') };
  const make = (fetchRows) => createTempLabelSource({ cachePath, logger: memoryLogger(), now: () => clock.now, fetchRows });
  const source = make(async () => ({ ok: true, rows: [{ row: 2, order: '5698', qty: '4' }] }));
  await source.refresh();
  assert.equal(source.status().stale, false);
  clock.now = new Date(clock.now.getTime() + STALE_AFTER_MS - 1000);
  assert.equal(source.status().stale, false, 'just under 24 hours');
  clock.now = new Date(clock.now.getTime() + 2000);
  const offline = make(async () => ({ ok: false, error: 'offline' }));
  await offline.refresh();
  assert.equal(offline.status().stale, true, 'over 24 hours');
  assert.deepEqual(offline.lookup('5698'), { ok: true, qty: 4 }, 'still prints');
  assert.equal(STALE_AFTER_MS, 24 * 60 * 60 * 1000);
  assert.equal(make(async () => ({ ok: false })).status().stale, true, 'a fresh start on an old cache warns straight away');
  const empty = createTempLabelSource({ cachePath: nodePath.join(dir, 'none.json'), logger: memoryLogger(), fetchRows: async () => ({ ok: false }) });
  assert.equal(empty.status().stale, false, 'no cache is "not loaded", not "old"');
});

// ---------------------------------------------------------------- website access key

function keyStore(dir, { available = true } = {}) {
  // a reversible stand-in for Windows DPAPI: the file must never hold the key in plain text
  const encrypt = (text) => Buffer.from(text, 'utf8').map((b) => b ^ 0x5a);
  const decrypt = (buffer) => Buffer.from(buffer).map((b) => b ^ 0x5a).toString('utf8');
  return createAccessKeyStore({ filePath: nodePath.join(dir, 'temp-labels-access-key.json'), isEncryptionAvailable: () => available, encrypt, decrypt });
}

test('access key: generated on this PC, stored encrypted, only its SHA-256 is ever shown', () => {
  const dir = tempDir();
  const store = keyStore(dir);
  assert.deepEqual(store.status(), { set: false });
  assert.equal(store.getKey(), null);

  const made = store.generate();
  assert.equal(made.ok, true);
  const key = store.getKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(made.sha256, sha256Hex(key));
  const status = store.status();
  assert.deepEqual(Object.keys(status).sort(), ['createdAt', 'problem', 'set', 'sha256', 'usable']);
  assert.equal(JSON.stringify(status).includes(key), false, 'status never carries the key');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'temp-labels-access-key.json'), 'utf8').includes(key), false, 'not stored in plain text');

  const replaced = store.generate();
  assert.notEqual(replaced.sha256, made.sha256, 'replacing makes a new key');
  assert.notEqual(store.getKey(), key);
});

test('access key: unreadable (other PC/user, tampered) or no secure storage never yields a key', () => {
  const dir = tempDir();
  const store = keyStore(dir);
  store.generate();
  const file = nodePath.join(dir, 'temp-labels-access-key.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, sha256: 'b'.repeat(64) }));
  assert.equal(store.getKey(), null);
  assert.equal(store.status().usable, false);
  assert.match(store.status().problem, /generate a new one/);
  fs.writeFileSync(file, '{ damaged');
  assert.deepEqual(store.status(), { set: false });

  const noStorage = keyStore(tempDir(), { available: false });
  assert.match(noStorage.generate().error, /secure storage is not available/);
});

// ---------------------------------------------------------------- station mapping

test('an enabled station prints its order\'s labels on its own printer', async () => {
  const h = harness({ stations: TWO_STATIONS });
  const decision = await scan(h, '5698-D');
  assert.equal(decision.result, 'triggered');
  assert.equal(h.calls.sent.length, 1, 'one batch = one raw submission');
  assert.equal(h.calls.sent[0].printerName, 'Zebra GK420D');
  assert.deepEqual(encodedCodes(h.calls.sent[0].zpl), ['5698-T-01', '5698-T-02', '5698-T-03', '5698-T-04']);
  assert.equal(h.calls.outcomes[0].result, 'submitted');
  assert.match(h.logger.text(), /Temporary label batch triggered - Order: 5698, Station: Pre-Hung, COM: COM5, Printer: Zebra GK420D, Quantity: 4, Codes: 5698-T-01 through 5698-T-04, Result: Submitted/);
});

test('a disabled station and an unmapped station print nothing', async () => {
  const h = harness({ stations: TWO_STATIONS });
  assert.equal((await scan(h, '5698-D', 'joint_assembly')).result, 'disabled');
  assert.equal((await scan(h, '5698-D', 'frame_finish')).result, 'disabled');
  assert.equal((await scan(h, '5698-D', '')).result, 'no-station');
  const noFile = harness();
  assert.equal((await scan(noFile, '5698-D')).result, 'disabled', 'no settings file at all means nothing prints');
  assert.equal(h.calls.sent.length + noFile.calls.sent.length, 0);
  assert.equal(h.calls.status.length, 0, 'the printer is not even checked');
});

test('the rule follows the STATION: a scanner moved to another COM port still prints', async () => {
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung', 'COM3');
  h.time.now += DEFAULT_SUPPRESSION_MS;
  await scan(h, '5698-D', 'joint_prehung', 'COM11');
  assert.deepEqual(h.calls.sent.map((s) => s.printerName), ['Zebra GK420D', 'Zebra GK420D']);
  assert.match(h.logger.text(), /COM: COM11, Printer: Zebra GK420D/);
});

test('two stations map to two different printers; a settings change applies to the next scan', async () => {
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  await scan(h, '5626-2-D', 'door_machining');
  assert.deepEqual(h.calls.sent.map((s) => s.printerName), ['Zebra GK420D', 'Zebra GK420D CNC']);
  assert.deepEqual(encodedCodes(h.calls.sent[1].zpl), ['5626-2-T-01', '5626-2-T-02', '5626-2-T-03']);

  settings.saveTempLabelSettings(h.settingsPath, { stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'Zebra GK420D CNC' }], layout: settings.DEFAULT_LAYOUT });
  await scan(h, '5626-2-D', 'joint_prehung');
  assert.equal(h.calls.sent[2].printerName, 'Zebra GK420D CNC');
  assert.equal((await scan(h, '5698-D', 'door_machining')).result, 'disabled', 'removed station stops at once');
});

// ---------------------------------------------------------------- printer

test('only the configured printer is ever checked or used - never a default or another printer', async () => {
  const h = harness({ stations: TWO_STATIONS, printers: { 'Zebra GK420D': 'ok', 'Windows Default': 'ok' } });
  await scan(h, '5698-D');
  assert.deepEqual(h.calls.status, ['Zebra GK420D']);
  assert.deepEqual(h.calls.sent.map((s) => s.printerName), ['Zebra GK420D']);

  // an enabled station with no printer cannot be saved, and a hand-edited one never guesses
  const saved = settings.validateTempLabelSettings({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: '' }], layout: settings.DEFAULT_LAYOUT });
  assert.equal(saved.ok, false);
  assert.match(saved.errors[0], /Choose a printer/);
  const noPrinter = harness();
  fs.writeFileSync(noPrinter.settingsPath, JSON.stringify({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: '' }] }));
  const decision = await scan(noPrinter, '5698-D');
  assert.equal(decision.result, 'disabled', 'an invalid file reads as nothing enabled');
  assert.equal(noPrinter.calls.sent.length, 0);

  // the trigger module has no way to find a default printer itself
  for (const file of ['temp-labels/trigger.js', 'temp-labels/zpl.js', 'temp-labels/codes.js', 'temp-labels/settings.js', 'temp-labels/source-cache.js']) {
    assert.doesNotMatch(read(file), /require\(['"][^'"]*(windows-printer|printer-settings|printer-service|print-job-processor|electron)['"]\)/, file);
    assert.doesNotMatch(read(file), /isDefault|getPrinterName/, file);
  }
});

test('an unavailable printer (missing, offline, Windows says offline, not Windows) fails safely and can be retried', async () => {
  for (const [printers, reason] of [
    [{}, /"Zebra GK420D" was not found on this PC/],
    [{ 'Zebra GK420D': 'offline' }, /reports "Zebra GK420D" as offline/],
    [{ 'Zebra GK420D': 'status-offline' }, /reports "Zebra GK420D" as offline/]
  ]) {
    const h = harness({ stations: TWO_STATIONS, printers });
    const decision = await scan(h, '5698-D');
    assert.equal((await decision.done).result, 'failed');
    assert.equal(h.calls.sent.length, 0);
    assert.match(h.logger.text(), new RegExp(`WARN Temporary label batch failed - Order: 5698, Station: Pre-Hung, COM: COM5, Printer: Zebra GK420D, Reason: Printer unavailable - .*${reason.source}`));
    assert.equal(h.calls.outcomes[0].result, 'failed');
    assert.equal((await scan(h, '5698-D')).result, 'triggered', 'a failed print never suppresses a rescan');
  }
  const notWindows = createPrinterCheck(async () => ({ supported: false, found: false, offline: false }), 'darwin');
  assert.match((await notWindows('Zebra GK420D')).reason, /only implemented on Windows \(this is darwin\)/);
});

test('a raw submission failure, a thrown printer check and a render failure all fail safely', async () => {
  const sendFails = harness({ stations: TWO_STATIONS, sendRaw: async () => { throw new Error('OpenPrinter failed'); } });
  const a = await scan(sendFails, '5698-D');
  assert.match((await a.done).reason, /Print submission to "Zebra GK420D" failed: OpenPrinter failed/);
  assert.equal(sendFails.trigger._recent.size, 0, 'retry allowed');

  const tooSmall = harness({ stations: TWO_STATIONS });
  const s = settings.loadTempLabelSettings(tooSmall.settingsPath);
  settings.saveTempLabelSettings(tooSmall.settingsPath, { ...s, layout: { ...s.layout, widthMm: 10, heightMm: 5 } });
  const b = await scan(tooSmall, '5698-D');
  assert.match((await b.done).reason, /Label generation failed: .*too small/);
  assert.equal(tooSmall.calls.sent.length, 0);
});

test('USB printing needs no network: with the internet down and a cache present, a scan still prints', async (t) => {
  const dir = tempDir();
  const cachePath = nodePath.join(dir, 'temp-labels-cache.json');
  await createTempLabelSource({ cachePath, logger: memoryLogger(), fetchRows: async () => ({ ok: true, rows: [{ row: 2, order: '5698', qty: '2' }] }) }).refresh();
  const offlineSource = createTempLabelSource({ cachePath, logger: memoryLogger(), fetchRows: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND' }) });
  await offlineSource.refresh();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network may be used while printing'); });

  const h = harness({ stations: TWO_STATIONS });
  const trigger = createTempLabelTrigger({
    getRule: (key) => settings.ruleForStation(settings.loadTempLabelSettings(h.settingsPath), key),
    lookupOrder: (order) => offlineSource.lookup(order),
    getLayout: () => settings.DEFAULT_LAYOUT,
    checkPrinter: async () => ({ ok: true }),
    sendRaw: async (printerName, buffer) => h.calls.sent.push({ printerName, zpl: buffer.toString('ascii') }),
    logger: memoryLogger()
  });
  const decision = trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung', portPath: 'COM5' });
  assert.equal((await decision.done).result, 'submitted');
  assert.deepEqual(encodedCodes(h.calls.sent[0].zpl), ['5698-T-01', '5698-T-02']);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('a missing order or an invalid row prints nothing, logs why, and can be scanned again', async () => {
  const h = harness({ stations: TWO_STATIONS, invalid: { 5700: 'Quantity is zero' } });
  const missing = await scan(h, '1234-D');
  assert.equal((await missing.done).result, 'failed');
  assert.match(h.logger.text(), /WARN Temporary labels not printed - Order: 1234, Station: Pre-Hung, COM: COM5, Printer: Zebra GK420D, Reason: Order not found in temporary-label source/);
  const bad = await scan(h, '5700-D');
  assert.match((await bad.done).reason, /Invalid temporary-label row: Quantity is zero/);
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.status.length, 0, 'printer not touched for a data problem');

  h.orders['1234'] = 2; // the sheet is fixed and refreshed
  assert.equal((await (await scan(h, '1234-D')).done).result, 'submitted', 'not suppressed after a failure');
});

test('batches print one at a time, in scan order, never interleaved', async () => {
  const started = [];
  const releases = [];
  const sendRaw = (printerName, buffer) => new Promise((resolve) => {
    started.push(encodedCodes(buffer.toString('ascii')));
    releases.push(resolve);
  });
  const h = harness({ stations: TWO_STATIONS, sendRaw, orders: { 5698: 2, 1234: 2, '5626-2': 1 } });
  const first = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung', portPath: 'COM5' });
  const second = h.trigger.handleScan({ value: '1234-D', stationKey: 'door_machining', portPath: 'COM6' });
  const third = h.trigger.handleScan({ value: '5626-2-D', stationKey: 'joint_prehung', portPath: 'COM5' });
  await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 1, 'second batch waits for the first');
  assert.deepEqual(started[0], ['5698-T-01', '5698-T-02']);
  releases[0]();
  await first.done;
  await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 2);
  releases[1]();
  await second.done;
  await new Promise((r) => setImmediate(r));
  releases[2]();
  await third.done;
  assert.deepEqual(started, [['5698-T-01', '5698-T-02'], ['1234-T-01', '1234-T-02'], ['5626-2-T-01']]);
});

test('the serial queue keeps going after a failed task', async () => {
  const queue = createSerialQueue();
  const order = [];
  const a = queue.run(async () => { order.push('a'); throw new Error('x'); });
  const b = queue.run(async () => { order.push('b'); return 'ok'; });
  await assert.rejects(a);
  assert.equal(await b, 'ok');
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(queue.pending, 0);
});

// ---------------------------------------------------------------- duplicate suppression

test('the same order at the same station scanned again straight away is suppressed and logged', async () => {
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5698-D');
  h.time.now += 10_000;
  assert.equal((await scan(h, '5698-D')).result, 'suppressed');
  assert.equal(h.calls.sent.length, 1);
  assert.match(h.logger.text(), /Temporary label batch suppressed - Order: 5698, Station: Pre-Hung, COM: COM5, Printer: Zebra GK420D, Reason: Duplicate scan within 45 seconds \(first scan 10s ago\)/);
  assert.equal(h.calls.outcomes.at(-1).result, 'suppressed');
});

test('a double scan while the first batch is still printing is suppressed too', async () => {
  let release;
  const h = harness({ stations: TWO_STATIONS, sendRaw: () => new Promise((r) => { release = r; }) });
  const first = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung' });
  assert.equal(h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung' }).result, 'suppressed');
  await new Promise((r) => setImmediate(r));
  release();
  await first.done;
});

test('the same order at another station follows that station\'s own mapping', async () => {
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  assert.equal((await scan(h, '5698-D', 'door_machining')).result, 'triggered');
  assert.deepEqual(h.calls.sent.map((s) => s.printerName), ['Zebra GK420D', 'Zebra GK420D CNC']);
});

test('after the suppression window the same order prints again - there is no permanent "already printed"', async () => {
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5698-D');
  h.time.now += DEFAULT_SUPPRESSION_MS - 1;
  assert.equal((await scan(h, '5698-D')).result, 'suppressed');
  h.time.now += 1;
  assert.equal((await scan(h, '5698-D')).result, 'triggered');
  assert.equal(h.calls.sent.length, 2);
  assert.equal(DEFAULT_SUPPRESSION_MS, 45_000);
  assert.equal(h.trigger._recent.size, 1, 'old entries are pruned');
});

// ---------------------------------------------------------------- the label (ZPL)

test('each label is ONE native Data Matrix (^BX, ECC200) encoding exactly the code - nothing else', () => {
  const label = zpl.buildTempLabelZpl('5698-T-01', settings.DEFAULT_LAYOUT);
  assert.equal((label.match(/\^XA/g) || []).length, 1);
  assert.equal((label.match(/\^BX/g) || []).length, 1);
  assert.equal((label.match(/\^FD/g) || []).length, 1, 'no text fields');
  assert.doesNotMatch(label, /\^GF|\^A0|\^B[^X]/, 'no bitmap, text or other barcode');
  assert.match(label, /\^BXN,8,200,14,14\^FD5698-T-01\^FS/);
  assert.deepEqual(encodedCodes(label), ['5698-T-01']);
});

test('the Data Matrix is centred on the label with a quiet zone of at least 2 modules', () => {
  const layout = { ...settings.DEFAULT_LAYOUT }; // 89x36mm at 203dpi = 711x288 dots (287.7 rounded)
  for (const code of ['5698-T-01', '5626-12-T-100', 'TEST-T-01']) {
    const box = zpl.layoutTempLabel(code, layout);
    assert.equal(box.widthDots, 711);
    assert.equal(box.heightDots, 288);
    const right = box.widthDots - (box.x + box.symbolDots);
    const bottom = box.heightDots - (box.y + box.symbolDots);
    assert.ok(Math.abs(box.x - right) <= 1, `${code} horizontally centred`);
    assert.ok(Math.abs(box.y - bottom) <= 1, `${code} vertically centred`);
    assert.ok(box.quietZoneDots >= 2 * box.moduleDots, `${code} quiet zone`);
    assert.match(zpl.buildTempLabelZpl(code, layout), new RegExp(`\\^FO${box.x},${box.y}\\^BXN,${box.moduleDots},200,${box.modules},${box.modules}`));
  }
  // calibration offsets come from the GK420D's measured shift and are applied once, at format level
  assert.match(zpl.buildTempLabelZpl('5698-T-01', layout), /\^PW711\n\^LL288\n\^LH0,0\n\^LS-24\n\^LT24\n/);
});

test('the symbol is always big enough for the code; small labels get smaller modules, too small is refused', () => {
  assert.equal(zpl.asciiCodewordCount('5698-T-01'), 6);
  assert.equal(zpl.symbolModulesFor('5698-T-01'), 14);
  assert.equal(zpl.symbolModulesFor('5626-12-T-100'), 16);
  for (const code of ['5698-T-01', '5626-2-T-01', '5626-123-T-200', 'TEST-T-01', 'A'.repeat(40)]) {
    const modules = zpl.symbolModulesFor(code);
    const capacity = zpl.ECC200_SQUARE_SIZES.find(([size]) => size === modules)[1];
    assert.ok(capacity >= zpl.asciiCodewordCount(code), code);
  }
  const small = zpl.layoutTempLabel('5698-T-01', { ...settings.DEFAULT_LAYOUT, widthMm: 25, heightMm: 15 });
  assert.ok(small.moduleDots < 8 && small.moduleDots >= zpl.MIN_MODULE_DOTS);
  assert.ok(small.quietZoneDots >= 2 * small.moduleDots);
  assert.throws(() => zpl.layoutTempLabel('5698-T-01', { ...settings.DEFAULT_LAYOUT, widthMm: 10, heightMm: 5 }), /too small/);
});

test('a batch is one document with one label per code, in sequence; ZPL control characters are refused', () => {
  const batch = zpl.buildTempBatchZpl(codes.generateTempCodes('5698', 12), settings.DEFAULT_LAYOUT);
  assert.equal((batch.match(/\^XA/g) || []).length, 12);
  assert.deepEqual(encodedCodes(batch), codes.generateTempCodes('5698', 12));
  for (const bad of ['5698^XZ', '5698~JA', 'lower', '', '-5698']) assert.throws(() => zpl.buildTempLabelZpl(bad, settings.DEFAULT_LAYOUT), /cannot be printed/, bad);
  assert.throws(() => zpl.buildTempBatchZpl([], settings.DEFAULT_LAYOUT), /No temporary labels/);
});

test('test print: ONE label with the typed code on the station printer, no suppression, bad codes refused', async () => {
  const h = harness({ stations: TWO_STATIONS });
  assert.deepEqual(await h.trigger.printTestLabel({ printerName: 'Zebra GK420D CNC', code: ' test-t-01 ', stationKey: 'door_machining' }), { ok: true, code: 'TEST-T-01' });
  await h.trigger.printTestLabel({ printerName: 'Zebra GK420D CNC', code: 'TEST-T-01' });
  assert.equal(h.calls.sent.length, 2);
  assert.deepEqual(encodedCodes(h.calls.sent[0].zpl), ['TEST-T-01']);
  assert.equal(h.calls.sent[0].printerName, 'Zebra GK420D CNC');
  assert.match(h.logger.text(), /Temporary test label - Station: Door CNC, Printer: Zebra GK420D CNC, Code: TEST-T-01, Result: Submitted/);
  assert.equal((await h.trigger.printTestLabel({ printerName: 'Zebra GK420D', code: 'TEST^XZ' })).ok, false);
  assert.equal((await h.trigger.printTestLabel({ printerName: '', code: 'TEST-T-01' })).ok, false);
  assert.match((await h.trigger.printTestLabel({ printerName: 'Gone', code: 'TEST-T-01' })).error, /not found/);
  assert.equal(h.calls.sent.length, 2);
});

// ---------------------------------------------------------------- settings

test('settings: station rows validated, layout range-checked, round trip', () => {
  const dir = tempDir();
  const p = nodePath.join(dir, 'temp-label-settings.json');
  assert.deepEqual(settings.loadTempLabelSettings(p), settings.defaultSettings(), 'no file = nothing enabled, default layout');
  const saved = settings.saveTempLabelSettings(p, { stations: TWO_STATIONS, layout: { ...settings.DEFAULT_LAYOUT, widthMm: '60', moduleDots: 6 } }, { installedPrinters: ['Zebra GK420D', 'Zebra GK420D CNC'] });
  assert.equal(saved.ok, true);
  assert.deepEqual(settings.loadTempLabelSettings(p), saved.settings);
  assert.equal(saved.settings.layout.widthMm, 60);

  const notInstalled = settings.validateTempLabelSettings({ stations: TWO_STATIONS, layout: settings.DEFAULT_LAYOUT }, { installedPrinters: ['Zebra GK420D'] });
  assert.match(notInstalled.errors.join(' '), /"Zebra GK420D CNC" is not installed/);
  const badLayout = settings.validateTempLabelSettings({ stations: [], layout: { widthMm: 0, heightMm: 'x', dpi: 150, moduleDots: 2.5, shiftXMm: 50, shiftYMm: 0 } });
  assert.equal(badLayout.errors.length, 5);
  assert.equal(settings.validateTempLabelSettings({ stations: [{ stationKey: 'nope', enabled: false }], layout: settings.DEFAULT_LAYOUT }).ok, false);

  fs.writeFileSync(p, JSON.stringify({ stations: TWO_STATIONS, layout: { widthMm: -1 } }));
  const half = settings.loadTempLabelSettings(p);
  assert.equal(half.stations.length, 3, 'good stations kept');
  assert.deepEqual(half.layout, settings.DEFAULT_LAYOUT, 'bad layout reads as default');
  fs.writeFileSync(p, '{ damaged');
  assert.deepEqual(settings.loadTempLabelSettings(p).stations, []);
});

test('a leftover door-print-settings.json from General Door Code Printing is ignored', () => {
  const dir = tempDir();
  fs.writeFileSync(nodePath.join(dir, 'door-print-settings.json'), JSON.stringify({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'TSC TE200' }] }));
  assert.deepEqual(settings.loadTempLabelSettings(nodePath.join(dir, 'temp-label-settings.json')), settings.defaultSettings(), 'not migrated, not read');
  const main = read('main.js');
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'temp-label-settings\.json'\)/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'temp-labels-cache\.json'\)/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'temp-labels-access-key\.json'\)/);
  assert.doesNotMatch(main, /'door-print-settings\.json'/, 'main.js never opens the old file');
});

// ---------------------------------------------------------------- existing behaviour

function fakeTrigger() {
  const calls = [];
  return { calls, handleScan: (scanArgs) => { calls.push(scanArgs.value); return { result: 'x' }; } };
}

test('every scan is still submitted exactly once and first; individual unit codes reach no print path', async () => {
  const h = harness({ stations: TWO_STATIONS });
  const order = [];
  for (const value of ['5698-D-01', '5626-2-D-01', '5698-F', '5698-DELIV', '5698-T-01', '5698-D']) {
    let posted = 0;
    runScanActions({
      postScan: () => { posted += 1; order.push(`post:${value}`); return Promise.resolve('sent'); },
      triggers: [{ handleScan: (s) => { order.push(`temp:${s.value}`); return h.trigger.handleScan(s); } }],
      scan: { value, stationKey: 'joint_prehung', portPath: 'COM5' }
    });
    assert.equal(posted, 1, value);
  }
  assert.deepEqual(order.slice(0, 2), ['post:5698-D-01', 'temp:5698-D-01'], 'post happens before the trigger');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.sent.length, 1, 'only 5698-D printed temporary labels');
  assert.deepEqual(encodedCodes(h.calls.sent[0].zpl).length, 4);
});

test('a throwing trigger cannot stop the scan or a later trigger', async () => {
  const errors = [];
  const later = fakeTrigger();
  const result = await runScanActions({
    postScan: () => Promise.resolve('sent'),
    triggers: [{ handleScan: () => { throw new Error('boom'); } }, later],
    scan: { value: '5698-D', stationKey: 'joint_prehung' },
    onTriggerError: (err) => errors.push(err.message)
  });
  assert.equal(result, 'sent');
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(later.calls, ['5698-D']);
  assert.equal(await runScanActions({ postScan: () => Promise.resolve('sent'), scan: { value: '5698-D' } }), 'sent', 'no triggers at all is fine');
});

test('the temporary trigger returns at once - printing never holds up the next scan', () => {
  const h = harness({ stations: TWO_STATIONS, sendRaw: () => new Promise(() => {}) });
  const decision = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung' });
  assert.equal(decision.result, 'triggered');
  assert.ok(decision.done instanceof Promise);
});

test('General Door Code Printing is retired: one automatic action on a general door code, no old code left', () => {
  for (const gone of ['general-door-trigger.js', 'general-door-trigger.test.js', 'door-print-settings.js']) {
    assert.equal(fs.existsSync(nodePath.join(SRC, gone)), false, gone);
  }
  const main = read('main.js');
  assert.match(main, /triggers: \[tempLabelTrigger\]/, 'the scan path has exactly one trigger');
  assert.doesNotMatch(main, /createGeneralDoorTrigger|generalDoorTrigger|recoverPendingGeneralDoorJobs|jobStationKey|createOrderLabelJob|require\(['"][^'"]*(door-print|general-door)|get-door-print-settings|save-door-print-settings|general-door-print-event/);
  assert.doesNotMatch(read('print-job-client.js'), /createOrderLabelJob|print-jobs\/order/);
  assert.doesNotMatch(read('preload.js'), /DoorPrint|door-print|GeneralDoor/);
  assert.doesNotMatch(read('index.html'), /door-print|General Door Code Printing/);
  assert.doesNotMatch(read('renderer.js'), /doorPrint|DoorPrint|GeneralDoor/);
  // the station-printer override General Door Code Printing added to the main pipeline is gone again
  assert.doesNotMatch(read('print-job-processor.js'), /printerName/);
  assert.doesNotMatch(read('printer-service.js'), /job\.printerName/);
});

test('main-printer (TE200 ready-label / delivery) printing: main printer, unchanged Windows job name', async (t) => {
  const printerSettings = require('../printer-settings');
  const printerService = require('../printer-service');
  const sent = [];
  t.mock.method(windowsPrinter, 'getPrinterStatus', async () => ({ supported: true, found: true, offline: false }));
  t.mock.method(windowsPrinter, 'sendRawData', async (...args) => { sent.push(args); });
  t.mock.method(printerSettings, 'getPrinterName', () => 'Zebra Main');
  const png = require('pngjs').PNG;
  const image = new png({ width: 8, height: 8 });
  image.data.fill(255);
  await printerService.printJob({ jobId: 'PJ-1', widthMm: 10, heightMm: 10, labels: [{ labelKey: 'L', imageBase64: png.sync.write(image).toString('base64') }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'Zebra Main');
  assert.equal(sent[0].length, 2, 'no job-name option passed - keeps the default name');
  for (const file of ['printer-service.js', 'print-job-processor.js', 'printing/zpl-image.js', 'scan-actions.js']) {
    assert.doesNotMatch(read(file), /require\([^)]*temp-labels/, file);
  }
});

test('Windows queue job names: temporary batches are "Temporary Labels - <order>", everything else keeps its name', async () => {
  assert.equal(windowsPrinter.DEFAULT_DOC_NAME, 'Door Tracker Delivery Label');
  assert.equal(windowsPrinter.cleanDocName(undefined), 'Door Tracker Delivery Label');
  assert.equal(windowsPrinter.cleanDocName(''), 'Door Tracker Delivery Label');
  assert.equal(windowsPrinter.cleanDocName('Temporary Labels - 5698'), 'Temporary Labels - 5698');
  assert.equal(windowsPrinter.cleanDocName('Temp\u0000\nLabels\u00e9'), 'TempLabels');
  assert.match(read('printing/windows-printer.js'), /\[string\]\$DocName = 'Door Tracker Delivery Label'/);

  assert.equal(tempJobName('5698'), 'Temporary Labels - 5698');
  const h = harness({ stations: TWO_STATIONS });
  await scan(h, '5626-2-D');
  await h.trigger.printTestLabel({ printerName: 'Zebra GK420D', code: 'TEST-T-01' });
  assert.deepEqual(h.calls.sent.map((x) => x.docName), ['Temporary Labels - 5626-2', 'Temporary Labels - TEST-T-01']);
});

test('Remote Admin and Delivery Photos are unchanged: no route to temporary labels', () => {
  const { ACTION_NAMES } = require('../remote-admin/actions');
  for (const name of ACTION_NAMES) assert.doesNotMatch(name, /temp|label|print/i, name);
  for (const dir of ['remote-admin', 'delivery-photos']) {
    for (const name of fs.readdirSync(nodePath.join(SRC, dir)).filter((n) => n.endsWith('.js'))) {
      assert.doesNotMatch(read(`${dir}/${name}`), /temp-labels|tempLabel|temp-label/, `${dir}/${name}`);
    }
  }
  const main = read('main.js');
  const adminWiring = main.slice(main.indexOf('const adminActions = createAdminActions('), main.indexOf('function remoteAdminPaths('));
  assert.ok(adminWiring.length > 100);
  assert.doesNotMatch(adminWiring, /tempLabel|temp-label/);
});
