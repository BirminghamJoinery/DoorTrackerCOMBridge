// General Door Code Printing: barcode recognition, the per-station rule,
// printer selection, duplicate-scan suppression, that the normal scan is
// always still submitted, and that triggered jobs go through the SAME
// PrintJobProcessor / printer-service path as every other job.
//
// No real printer, website or Electron: printers, job creation and the
// website's status endpoint are injected fakes; settings and the print
// attempt store are real files in a temp folder.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { PNG } = require('pngjs');

const {
  parseGeneralDoorCode,
  createGeneralDoorTrigger,
  runScanActions,
  jobStationKey,
  DEFAULT_SUPPRESSION_MS
} = require('./general-door-trigger');
const doorPrintSettings = require('./door-print-settings');
const { PrintJobProcessor } = require('./print-job-processor');
const { createPrintAttemptStore } = require('./print-attempt-store');
const printJobClient = require('./print-job-client');

function tempFile(name) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'combridge-door-print-'));
  return nodePath.join(dir, name);
}

function silentLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(['INFO', m]),
    warn: (m) => lines.push(['WARN', m]),
    error: (m) => lines.push(['ERROR', m])
  };
}

// A trigger wired to a real settings file and fake printer/website/queue.
function harness({ settings, printers = { 'TSC TE200': 'ok', 'TSC TE200 CNC': 'ok' }, createJob, clock } = {}) {
  const settingsPath = tempFile('door-print-settings.json');
  if (settings) doorPrintSettings.saveDoorPrintSettings(settingsPath, settings);
  const logger = silentLogger();
  const calls = { checkPrinter: [], createJob: [], enqueue: [], outcomes: [] };
  let jobCounter = 0;
  const time = clock || { now: 1_000_000 };

  const trigger = createGeneralDoorTrigger({
    getRule: (stationKey) => doorPrintSettings.ruleForStation(doorPrintSettings.loadDoorPrintSettings(settingsPath), stationKey),
    checkPrinter: async (name) => {
      calls.checkPrinter.push(name);
      const state = printers[name];
      if (state === 'ok') return { ok: true };
      return { ok: false, reason: state === 'offline' ? `Printer unavailable - "${name}" is offline` : `Printer unavailable - "${name}" was not found on this PC` };
    },
    createJob: createJob || (async (args) => {
      calls.createJob.push(args);
      jobCounter += 1;
      return { ok: true, apiBase: 'https://example.test', job: { jobId: `PJ-${jobCounter}`, widthMm: 89, heightMm: 36, labels: [] } };
    }),
    enqueue: (job, apiBase, options) => calls.enqueue.push({ job, apiBase, options }),
    logger,
    stationLabel: (key) => ({ joint_prehung: 'Pre-Hung', door_machining: 'Door CNC', joint_assembly: 'Assembly' }[key] || key),
    onOutcome: (o) => calls.outcomes.push(o),
    now: () => time.now
  });

  return { trigger, settingsPath, logger, calls, time };
}

const TWO_STATIONS = {
  stations: [
    { stationKey: 'joint_prehung', enabled: true, printerName: 'TSC TE200' },
    { stationKey: 'door_machining', enabled: true, printerName: 'TSC TE200 CNC' },
    { stationKey: 'joint_assembly', enabled: false, printerName: '' }
  ]
};

async function scan(h, value, stationKey, portPath = 'COM7') {
  const decision = h.trigger.handleScan({ value, stationKey, portPath, apiUrl: 'https://example.test/api/com-scans' });
  if (decision.done) await decision.done;
  return decision;
}

// ---------- Barcode recognition ----------

test('general door codes are recognised and the order number (with any call-off) extracted', () => {
  assert.deepEqual(parseGeneralDoorCode('5698-D'), { order: '5698' });
  assert.deepEqual(parseGeneralDoorCode('5626-2-D'), { order: '5626-2' });
  assert.deepEqual(parseGeneralDoorCode('1234-D'), { order: '1234' });
  assert.deepEqual(parseGeneralDoorCode('1234-1-D'), { order: '1234-1' });
  assert.deepEqual(parseGeneralDoorCode('  5698-d \r'), { order: '5698' }, 'scanner whitespace / lower case');
});

test('individual door, frame, delivery, bare order and junk codes are NOT general door codes', () => {
  for (const code of ['5698-D-01', '5698-D-02', '5626-2-D-01', '5698-F', '5626-2-F', '5698-DELIV', '5698', 'ABC-D', 'random text', '', '12345-D', '569-D', '5698--D', '5698-D-', '5626-2-3-D', '5698-DD', '5698 -D', null, undefined, 5698]) {
    assert.equal(parseGeneralDoorCode(code), null, JSON.stringify(code));
  }
});

// ---------- Station mapping ----------

test('an enabled station triggers a print job on its own printer', async () => {
  const h = harness({ settings: TWO_STATIONS });
  const decision = await scan(h, '5626-2-D', 'joint_prehung', 'COM7');
  assert.equal(decision.result, 'triggered');
  assert.deepEqual(h.calls.createJob, [{ order: '5626-2', stationKey: 'joint_prehung', portPath: 'COM7', apiUrl: 'https://example.test/api/com-scans' }]);
  assert.equal(h.calls.enqueue.length, 1);
  assert.deepEqual(h.calls.enqueue[0].options, { printerName: 'TSC TE200' });
  const success = h.logger.lines.find(([, m]) => m.startsWith('General door label trigger -'));
  assert.match(success[1], /Order: 5626-2, Station: Pre-Hung, COM: COM7, Printer: TSC TE200, Result: Print job created, Job ID: PJ-1/);
});

test('a disabled station and an unmapped station do nothing', async () => {
  const h = harness({ settings: TWO_STATIONS });
  assert.equal((await scan(h, '5698-D', 'joint_assembly')).result, 'disabled');
  assert.equal((await scan(h, '5698-D', 'door_cutting')).result, 'disabled');
  assert.equal((await scan(h, '5698-D', '')).result, 'no-station');
  assert.equal(h.calls.createJob.length + h.calls.enqueue.length + h.calls.checkPrinter.length, 0);
});

test('no settings file at all means nothing prints', async () => {
  const h = harness();
  assert.equal((await scan(h, '5698-D', 'joint_prehung')).result, 'disabled');
  assert.equal(h.calls.enqueue.length, 0);
});

test('the rule follows the STATION, not the COM port: a scanner moved to another port still prints', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung', 'COM5');
  await scan(h, '5699-D', 'joint_prehung', 'COM9');
  assert.deepEqual(h.calls.enqueue.map((e) => e.options.printerName), ['TSC TE200', 'TSC TE200']);
  assert.deepEqual(h.calls.createJob.map((c) => c.portPath), ['COM5', 'COM9']);
});

test('two stations map to two different printers', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  await scan(h, '5698-D', 'door_machining', 'COM8');
  assert.deepEqual(h.calls.enqueue.map((e) => e.options.printerName), ['TSC TE200', 'TSC TE200 CNC']);
});

// ---------- Printer selection ----------

test('changing the station printer in settings changes the very next print', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  doorPrintSettings.saveDoorPrintSettings(h.settingsPath, { stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'TSC TE200 CNC' }] });
  await scan(h, '5700-D', 'joint_prehung');
  assert.deepEqual(h.calls.enqueue.map((e) => e.options.printerName), ['TSC TE200', 'TSC TE200 CNC']);
});

test('an unavailable printer fails safely: no job created, nothing queued, a clear log line, and the scan can be retried', async () => {
  const h = harness({ settings: TWO_STATIONS, printers: { 'TSC TE200': 'missing' } });
  const decision = await scan(h, '5698-D', 'joint_prehung');
  assert.equal(decision.result, 'triggered');
  assert.equal(h.calls.createJob.length, 0);
  assert.equal(h.calls.enqueue.length, 0);
  const failure = h.logger.lines.find(([level]) => level === 'WARN');
  assert.match(failure[1], /General door label trigger failed - Order: 5698, Station: Pre-Hung, COM: COM7, Printer: TSC TE200, Reason: Printer unavailable/);
  assert.equal(h.calls.outcomes.at(-1).result, 'failed');
  // a failure never counts as "already printed" - rescanning tries again at once
  h.calls.checkPrinter.length = 0;
  await scan(h, '5698-D', 'joint_prehung');
  assert.equal(h.calls.checkPrinter.length, 1);
});

test('an offline printer and a thrown printer check also fail safely', async () => {
  const offline = harness({ settings: TWO_STATIONS, printers: { 'TSC TE200': 'offline' } });
  await scan(offline, '5698-D', 'joint_prehung');
  assert.equal(offline.calls.enqueue.length, 0);
  assert.match(offline.calls.outcomes[0].reason, /offline/);

  const enqueued = [];
  const throwing = createGeneralDoorTrigger({
    getRule: () => ({ enabled: true, printerName: 'TSC TE200' }),
    checkPrinter: async () => { throw new Error('PowerShell timed out'); },
    createJob: async () => { throw new Error('must not be called'); },
    enqueue: (...args) => enqueued.push(args),
    logger: silentLogger()
  });
  const decision = throwing.handleScan({ value: '5698-D', stationKey: 'joint_prehung' });
  assert.deepEqual(await decision.done, { result: 'failed', reason: 'PowerShell timed out' });
  assert.equal(enqueued.length, 0);
});

test('an enabled station with no printer never guesses one', async () => {
  const h = harness();
  fs.writeFileSync(h.settingsPath, JSON.stringify({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: '' }] }));
  const decision = await scan(h, '5698-D', 'joint_prehung');
  // an invalid file (enabled with no printer) reads as "nothing enabled"
  assert.equal(decision.result, 'disabled');
  assert.equal(h.calls.enqueue.length, 0);
});

test('website failures (order not found, label lookup failed, network error) fail safely and do not throw', async () => {
  for (const createJob of [
    async () => ({ ok: false, error: 'No QUEUED snapshot / order not found' }),
    async () => ({ ok: false, error: 'Could not read PRINT_PROFILES' }),
    async () => { throw new Error('fetch failed'); },
    async () => ({ ok: true, job: null })
  ]) {
    const h = harness({ settings: TWO_STATIONS, createJob });
    const decision = await scan(h, '5698-D', 'joint_prehung');
    assert.equal(decision.result, 'triggered');
    assert.equal(h.calls.enqueue.length, 0);
    assert.equal(h.calls.outcomes.at(-1).result, 'failed');
    assert.match(h.calls.outcomes.at(-1).reason, /Print job not created/);
  }
});

// ---------- Duplicate protection ----------

test('the same order at the same station scanned again straight away is suppressed and logged', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  const second = await scan(h, '5698-D', 'joint_prehung', 'COM9');
  assert.equal(second.result, 'suppressed');
  assert.equal(h.calls.enqueue.length, 1);
  const line = h.logger.lines.find(([, m]) => m.startsWith('General door label trigger suppressed'));
  assert.match(line[1], /Order: 5698, Station: Pre-Hung, .*Reason: Duplicate scan within suppression window/);
});

test('a double scan while the first is still in progress is also suppressed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    settings: TWO_STATIONS,
    createJob: async () => { await gate; return { ok: true, apiBase: 'https://example.test', job: { jobId: 'PJ-slow' } }; }
  });
  const first = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung', portPath: 'COM7' });
  const second = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung', portPath: 'COM7' });
  assert.equal(second.result, 'suppressed');
  release();
  await first.done;
  assert.equal(h.calls.enqueue.length, 1);
});

test('the same order at ANOTHER station follows that station\'s own rule', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  assert.equal((await scan(h, '5698-D', 'door_machining')).result, 'triggered');
  assert.equal((await scan(h, '5698-D', 'joint_assembly')).result, 'disabled');
  assert.deepEqual(h.calls.enqueue.map((e) => e.options.printerName), ['TSC TE200', 'TSC TE200 CNC']);
});

test('after the suppression window the same order prints again (no permanent block)', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  h.time.now += DEFAULT_SUPPRESSION_MS - 1;
  assert.equal((await scan(h, '5698-D', 'joint_prehung')).result, 'suppressed');
  h.time.now += 2;
  assert.equal((await scan(h, '5698-D', 'joint_prehung')).result, 'triggered');
  assert.equal(h.calls.enqueue.length, 2);
  assert.ok(DEFAULT_SUPPRESSION_MS >= 30000 && DEFAULT_SUPPRESSION_MS <= 60000);
});

test('a different order at the same station is not suppressed', async () => {
  const h = harness({ settings: TWO_STATIONS });
  await scan(h, '5698-D', 'joint_prehung');
  assert.equal((await scan(h, '5626-2-D', 'joint_prehung')).result, 'triggered');
});

// ---------- Existing scan behaviour ----------

test('every scan is still submitted exactly as before; only general door codes reach the trigger\'s print path', async () => {
  const h = harness({ settings: TWO_STATIONS });
  const posted = [];
  for (const value of ['5698-D-01', '5626-2-D-01', '5698-F', '5626-2-F', '5698-DELIV', '5698', 'random text', '5698-D']) {
    runScanActions({
      postScan: () => { posted.push(value); return Promise.resolve(); },
      trigger: h.trigger,
      scan: { value, stationKey: 'joint_prehung', portPath: 'COM7', apiUrl: 'https://example.test/api/com-scans' }
    });
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 8, 'every code still posted');
  assert.deepEqual(h.calls.createJob.map((c) => c.order), ['5698'], 'only the general door code printed');
});

test('the scan is submitted first, and a failing or throwing trigger cannot stop or fail it', async () => {
  const order = [];
  const throwing = { handleScan: () => { order.push('trigger'); throw new Error('boom'); } };
  const errors = [];
  const result = runScanActions({
    postScan: () => { order.push('post'); return 'scan-result'; },
    trigger: throwing,
    scan: { value: '5698-D', stationKey: 'joint_prehung' },
    onTriggerError: (err) => errors.push(err.message)
  });
  assert.equal(result, 'scan-result');
  assert.deepEqual(order, ['post', 'trigger']);
  assert.deepEqual(errors, ['boom']);
});

test('the trigger returns at once - printing work never holds up the next scan', () => {
  const h = harness({
    settings: TWO_STATIONS,
    createJob: () => new Promise(() => {}) // never answers
  });
  const decision = h.trigger.handleScan({ value: '5698-D', stationKey: 'joint_prehung', portPath: 'COM7' });
  assert.equal(decision.result, 'triggered');
  assert.equal(h.trigger.handleScan({ value: '5699-D', stationKey: 'joint_prehung', portPath: 'COM7' }).result, 'triggered');
});

// ---------- Settings ----------

test('settings are validated: known stations only, no duplicates, an enabled station needs an installed printer', () => {
  const v = doorPrintSettings.validateDoorPrintSettings;
  assert.equal(v({ stations: [{ stationKey: 'not_a_station', enabled: true, printerName: 'X' }] }).ok, false);
  assert.equal(v({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'X' }, { stationKey: 'joint_prehung', enabled: false, printerName: '' }] }).ok, false);
  assert.equal(v({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: '' }] }).ok, false);
  assert.equal(v({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'bad\nname' }] }).ok, false);
  assert.equal(v({ stations: [{ stationKey: 'joint_prehung', enabled: true, printerName: 'Gone' }] }, { installedPrinters: ['TSC TE200'] }).ok, false);
  assert.equal(v({ stations: [{ stationKey: 'joint_prehung', enabled: false, printerName: 'Gone' }] }, { installedPrinters: ['TSC TE200'] }).ok, true, 'a disabled station may keep an old printer');
  assert.deepEqual(v({ stations: [{ stationKey: 'joint_prehung', enabled: 'yes', printerName: ' TSC TE200 ' }] }).settings, { stations: [{ stationKey: 'joint_prehung', enabled: false, printerName: 'TSC TE200' }] });
});

test('settings survive a save/load round trip and a damaged file reads as "nothing enabled"', () => {
  const file = tempFile('door-print-settings.json');
  assert.equal(doorPrintSettings.saveDoorPrintSettings(file, TWO_STATIONS).ok, true);
  assert.deepEqual(doorPrintSettings.loadDoorPrintSettings(file), TWO_STATIONS);
  assert.equal(doorPrintSettings.saveDoorPrintSettings(file, { stations: [{ stationKey: 'nope' }] }).ok, false);
  assert.deepEqual(doorPrintSettings.loadDoorPrintSettings(file), TWO_STATIONS, 'a refused save leaves the file alone');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(doorPrintSettings.loadDoorPrintSettings(file), { stations: [] });
});

// ---------- Print processor / printer-service integration ----------

function tinyPngBase64() {
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(255);
  return PNG.sync.write(png).toString('base64');
}

async function drain(processor) {
  while (processor.processing || processor.queue.length > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a triggered job goes through the existing processor: CLAIMED -> PRINTING -> PRINTED, attempt record written then cleared, on the station printer', async () => {
  const storePath = tempFile('print-attempts.json');
  const store = createPrintAttemptStore(storePath);
  const printed = [];
  const statesSeenDuringPrint = [];
  const reports = [];
  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: async (job) => {
      statesSeenDuringPrint.push(store.get(job.jobId) && store.get(job.jobId).state);
      printed.push(job);
    },
    reportJobStatus: async (apiBase, jobId, status) => { reports.push(status); return { ok: true }; }
  });

  const h = harness({
    settings: TWO_STATIONS,
    createJob: async () => ({ ok: true, apiBase: 'https://example.test', job: { jobId: 'PJ-real-shape', widthMm: 89, heightMm: 36, labels: [{ labelKey: 'DELIVERY_LABEL', sequence: 1, imageBase64: 'aGVsbG8=' }], profileKey: 'DELIVERY_STANDARD' } })
  });
  // the real processor's enqueue, exactly as main.js wires it
  const trigger = createGeneralDoorTrigger({
    getRule: (key) => doorPrintSettings.ruleForStation(doorPrintSettings.loadDoorPrintSettings(h.settingsPath), key),
    checkPrinter: async () => ({ ok: true }),
    createJob: async () => ({ ok: true, apiBase: 'https://example.test', job: { jobId: 'PJ-real-shape', widthMm: 89, heightMm: 36, labels: [{ labelKey: 'DELIVERY_LABEL', sequence: 1, imageBase64: 'aGVsbG8=' }] } }),
    enqueue: (job, apiBase, options) => processor.enqueue(job, apiBase, options),
    logger: silentLogger()
  });

  await trigger.handleScan({ value: '5698-D', stationKey: 'door_machining', portPath: 'COM8', apiUrl: 'x' }).done;
  await drain(processor);

  assert.equal(printed.length, 1);
  assert.equal(printed[0].printerName, 'TSC TE200 CNC');
  assert.deepEqual(statesSeenDuringPrint, ['ATTEMPTING']);
  assert.deepEqual(reports, ['CLAIMED', 'PRINTING', 'PRINTED']);
  assert.equal(store.get('PJ-real-shape'), null, 'record cleared only after PRINTED was acknowledged');

  // the existing per-job_id idempotency still applies
  const events = [];
  processor.onEvent = (e) => events.push(e);
  processor.enqueue({ jobId: 'PJ-real-shape', widthMm: 89, heightMm: 36, labels: [{ labelKey: 'DELIVERY_LABEL', imageBase64: 'aGVsbG8=' }] }, 'https://example.test', { printerName: 'TSC TE200 CNC' });
  await drain(processor);
  assert.equal(printed.length, 1, 'the same job_id is never printed twice');
  assert.equal(events[0].status, 'SKIPPED');
});

test('a recovered job with a SUBMITTED record is never printed again, whichever printer it was addressed to', async () => {
  const store = createPrintAttemptStore(tempFile('print-attempts.json'));
  store.setSubmitted('PJ-done');
  let printCalls = 0;
  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: async () => { printCalls += 1; },
    reportJobStatus: async () => ({ ok: true })
  });
  processor.enqueue({ jobId: 'PJ-done', widthMm: 89, heightMm: 36, labels: [{ labelKey: 'L', imageBase64: 'aGVsbG8=' }] }, 'https://example.test', { printerName: 'TSC TE200' });
  await drain(processor);
  assert.equal(printCalls, 0);
});

test('a job without a station printer behaves exactly as before (no printerName added)', async () => {
  const seen = [];
  const processor = new PrintJobProcessor({ printPhysically: async (job) => seen.push(job), reportJobStatus: async () => ({ ok: true }) });
  processor.enqueue({ jobId: 'PJ-plain', widthMm: 89, heightMm: 36, labels: [{ labelKey: 'L', imageBase64: 'aGVsbG8=' }] }, 'https://example.test');
  await drain(processor);
  assert.equal('printerName' in seen[0], false);
});

test('printer-service prints a station job to exactly its printer and never falls back to the main or default printer', async (t) => {
  const windowsPrinter = require('./printing/windows-printer');
  const printerSettings = require('./printer-settings');
  const printerService = require('./printer-service');
  const sent = [];
  const known = { 'TSC TE200': { supported: true, found: true, offline: false }, 'Zebra Main': { supported: true, found: true, offline: false } };
  t.mock.method(windowsPrinter, 'getPrinterStatus', async (name) => known[name] || { supported: true, found: false, offline: false });
  t.mock.method(windowsPrinter, 'sendRawData', async (name) => { sent.push(name); });
  const mainLookup = t.mock.method(printerSettings, 'getPrinterName', () => 'Zebra Main');

  const job = { jobId: 'PJ-x', widthMm: 10, heightMm: 10, labels: [{ labelKey: 'L', sequence: 1, imageBase64: tinyPngBase64() }] };

  await printerService.printJob({ ...job, printerName: 'TSC TE200' });
  assert.deepEqual(sent, ['TSC TE200']);
  assert.equal(mainLookup.mock.callCount(), 0, 'the main printer setting is not even consulted');

  await assert.rejects(printerService.printJob({ ...job, printerName: 'TSC Removed' }), /"TSC Removed" was not found/);
  assert.deepEqual(sent, ['TSC TE200'], 'nothing sent anywhere when the station printer is missing');

  await printerService.printJob(job);
  assert.deepEqual(sent, ['TSC TE200', 'Zebra Main'], 'ordinary jobs still use the main printer');
});

test('the trigger has no printer access of its own - it can only reach a printer through the injected processor', () => {
  const source = fs.readFileSync(nodePath.join(__dirname, 'general-door-trigger.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"][^'"]*(printer|printing|print-job-processor|electron)/);
});

test('createOrderLabelJob asks the website for the order\'s normal label job (no real network)', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 201, json: async () => ({ printJob: { jobId: 'PJ-1', labels: [] } }) };
  });
  const result = await printJobClient.createOrderLabelJob('https://example.test', { order: '5626-2', stationKey: jobStationKey('joint_prehung'), device: 'COM7', source: 'combridge_general_door' });
  assert.equal(result.ok, true);
  assert.equal(result.job.jobId, 'PJ-1');
  assert.deepEqual(requests, [{ url: 'https://example.test/api/print-jobs/order', body: { order: '5626-2', station_key: 'general-door:joint_prehung', device: 'COM7', source: 'combridge_general_door' } }]);

  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 501, statusText: 'Not Implemented', json: async () => ({ error: 'No active print profile' }) }));
  assert.deepEqual(await printJobClient.createOrderLabelJob('https://example.test', { order: '5698' }), { ok: false, error: 'No active print profile' });
  assert.equal((await printJobClient.createOrderLabelJob(null, { order: '5698' })).ok, false);
});
