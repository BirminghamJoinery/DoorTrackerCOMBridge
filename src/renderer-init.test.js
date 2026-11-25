// The Windows app's start-up (renderer.js init()), run for real: the actual
// src/index.html + com-options.js + init-sections.js + renderer.js in a real
// Chromium (installed Chrome, else Edge), with the preload APIs
// (window.comBridge, window.tempLabels, ...) replaced by stubs whose answers
// each test chooses - so a failing printer discovery, an unreadable settings
// file, etc. can be produced on demand.
//
// Regression for: printer discovery failing ("Command failed: powershell.exe
// ... -File <temp .ps1>") left the Temporary Data Matrix station dropdown,
// layout fields, source status and key status empty, because init() awaited
// each part in turn with no error handling.
//
// Skips cleanly if this machine has neither Chrome nor Edge installed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const { pathToFileURL } = require('node:url');

const { STATIONS } = require('./com-options');

const INDEX_URL = pathToFileURL(nodePath.join(__dirname, 'index.html')).href;
const DEFAULT_LAYOUT = { widthMm: 89, heightMm: 36, dpi: 203, moduleDots: 8, shiftXMm: 0, shiftYMm: 0 };
const AWKWARD_PRINTERS = [
  { name: 'ZDesigner GK420d', isDefault: false, isOffline: true },
  { name: 'TSC TE210 #2', isDefault: false, isOffline: false },
  { name: '\\\\DESKTOP-5OHKE65.bjltd.local\\TOSHIBA B-FV4 (203 dpi)', isDefault: false, isOffline: false },
  { name: 'O\'Brien "Label" & Co, #3', isDefault: true, isOffline: false }
];
const PRINTER_TIMEOUT = 'PowerShell did not finish within 30s and was stopped';

let browser = null;

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    return null;
  }
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // try the next one
    }
  }
  return null;
}

test.before(async () => {
  browser = await launchBrowser();
});

test.after(async () => {
  if (browser) await browser.close();
});

// What each stubbed IPC method answers. A value { reject: 'message' } makes
// that call reject, the way a failing ipcRenderer.invoke() does.
function baseResponses() {
  return {
    'comBridge.loadSettings': { apiUrl: 'https://example.invalid/api/com-scans', tabs: [{ id: 't1', comPort: '', baudRate: 19200, stationKey: 'door_cutting' }] },
    'comBridge.listPorts': [],
    'comBridge.listPrinters': { supported: true, printers: AWKWARD_PRINTERS, warnings: [], details: 'ok', method: 'inline' },
    'comBridge.getPrinterName': 'TSC TE210 #2',
    'comBridge.getPrinterStatus': { supported: true, found: true, offline: false, statusOffline: false },
    'comBridge.logDiagnostic': { ok: true },
    'tempLabels.getSettings': {
      settings: { stations: [{ stationKey: 'door_cutting', enabled: true, printerName: 'TSC TE210 #2' }], layout: DEFAULT_LAYOUT },
      defaults: DEFAULT_LAYOUT,
      maxPerScan: 200,
      status: { state: 'cached', ordersCached: 45, lastSuccessAt: '2026-11-25T08:11:28.356Z' }
    },
    'tempLabels.getStatus': { state: 'cached', ordersCached: 45, lastSuccessAt: '2026-11-25T08:11:28.356Z' },
    'tempLabels.getKeyStatus': { set: false },
    'tempLabels.generateKey': { ok: true, status: { set: true, usable: true, createdAt: '2026-11-25T09:00:00.000Z', sha256: 'ab'.repeat(32) } },
    'deliveryPhotos.getConfig': { ok: false },
    'deliveryPhotos.getStatus': {},
    'deliveryPhotos.getTrackingStatus': {},
    'remoteAdmin.getSettings': { config: { enabled: false, port: 8765 }, urls: [], status: {} },
    'appUpdates.getState': {}
  };
}

// Stubs for every preload namespace: any method answers from `responses`
// (default {}), on* subscriptions just register. Every call is recorded.
function installStubs({ responses }) {
  window.__calls = [];
  const answer = (key) => {
    window.__calls.push(key);
    const value = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : {};
    if (value && typeof value === 'object' && typeof value.reject === 'string') {
      return Promise.reject(new Error(`Error invoking remote method: ${value.reject}`));
    }
    return Promise.resolve(JSON.parse(JSON.stringify(value)));
  };
  const namespace = (ns) => new Proxy({}, {
    get: (_, method) => (...args) => {
      if (typeof method === 'string' && /^on[A-Z]/.test(method)) return undefined;
      return answer(`${ns}.${String(method)}`, args);
    }
  });
  for (const ns of ['comBridge', 'tempLabels', 'deliveryPhotos', 'remoteAdmin', 'appUpdates']) window[ns] = namespace(ns);
  window.confirm = () => true;
}

// Loads the page with the given stub answers and waits for init() to finish.
async function openApp(t, overrides = {}) {
  if (!browser) {
    t.skip('Chrome/Edge not available');
    return null;
  }
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript(installStubs, { responses: { ...baseResponses(), ...overrides } });
  await page.goto(INDEX_URL);
  await page.waitForFunction(() => window.comBridgeInitDone !== undefined);
  const results = await page.evaluate(() => window.comBridgeInitDone);
  const read = () => page.evaluate(() => {
    const options = (id) => [...document.getElementById(id).options].map((o) => ({ value: o.value, text: o.textContent }));
    const shown = (id) => {
      const el = document.getElementById(id);
      return el.hidden ? '' : el.textContent;
    };
    return {
      stationOptions: options('temp-label-station'),
      tempPrinterOptions: options('temp-label-printer'),
      tempPrinterValue: document.getElementById('temp-label-printer').value,
      printerOptions: options('printer-select'),
      tempPrinterError: shown('temp-label-printer-error'),
      printerListError: shown('printer-list-error'),
      tempLabelError: shown('temp-label-error'),
      layout: {
        width: document.getElementById('temp-layout-width').value,
        height: document.getElementById('temp-layout-height').value,
        module: document.getElementById('temp-layout-module').value
      },
      sourceBadge: document.getElementById('temp-label-source-badge').textContent,
      sourceDetail: document.getElementById('temp-label-source-detail').textContent,
      keyBadge: document.getElementById('temp-key-badge').textContent,
      keyButton: document.getElementById('temp-key-generate-btn').textContent,
      ruleRows: document.getElementById('temp-label-body').textContent,
      diagnostics: window.__calls.filter((c) => c === 'comBridge.logDiagnostic').length,
      listPrintersCalls: window.__calls.filter((c) => c === 'comBridge.listPrinters').length
    };
  });
  return { page, results, read, pageErrors };
}

const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));
const expectedStationLabels = STATIONS.map((s) => s.label);

test('working path: station AND printer dropdowns both populate, nothing fails', async (t) => {
  const app = await openApp(t);
  if (!app) return;
  const state = await app.read();
  assert.deepEqual(state.stationOptions.map((o) => o.text), expectedStationLabels);
  assert.deepEqual(state.tempPrinterOptions.map((o) => o.value), ['', ...AWKWARD_PRINTERS.map((p) => p.name)]);
  assert.equal(state.tempPrinterOptions[1].text, 'ZDesigner GK420d (offline)');
  assert.deepEqual(state.printerOptions.map((o) => o.value), AWKWARD_PRINTERS.map((p) => p.name));
  assert.equal(state.tempPrinterValue, 'TSC TE210 #2', 'Door Cut\'s saved printer is selected');
  assert.equal(state.tempPrinterError, '');
  assert.equal(state.printerListError, '');
  assert.deepEqual(state.layout, { width: '89', height: '36', module: '8' });
  assert.equal(state.sourceBadge, 'Cached');
  assert.equal(state.keyBadge, 'Not set');
  assert.equal(state.listPrintersCalls, 1, 'one discovery feeds both dropdowns');
  assert.ok(app.results.every((r) => r.ok), JSON.stringify(app.results.filter((r) => !r.ok)));
  assert.match(byName(app.results)['Temporary label station list'].detail, new RegExp(`^${STATIONS.length} stations$`));
  assert.equal(byName(app.results)['Printer list'].detail, '4 printer(s)');
  assert.ok(state.diagnostics >= 1, 'the summary line was sent to the COM Bridge log');
  await app.page.close();
});

test('printer discovery REJECTS: stations, layout, source and key status still load; the printer error is shown', async (t) => {
  const app = await openApp(t, { 'comBridge.listPrinters': { reject: PRINTER_TIMEOUT } });
  if (!app) return;
  const state = await app.read();
  assert.deepEqual(state.stationOptions.map((o) => o.text), expectedStationLabels);
  assert.match(state.tempPrinterError, /Could not read the installed printers: .*PowerShell did not finish within 30s/);
  assert.match(state.printerListError, /PowerShell did not finish within 30s/);
  assert.equal(state.tempPrinterOptions[0].text, 'Could not list printers (see below)');
  // The station's saved printer is still offered, so it can be re-saved/removed.
  assert.equal(state.tempPrinterValue, 'TSC TE210 #2');
  assert.doesNotMatch(state.ruleRows, /not found on this PC/, 'an unknown list is not "missing"');
  assert.deepEqual(state.layout, { width: '89', height: '36', module: '8' });
  assert.equal(state.sourceBadge, 'Cached');
  assert.match(state.sourceDetail, /Orders cached: 45/);
  assert.equal(state.keyBadge, 'Not set');

  const results = byName(app.results);
  assert.equal(results['Printer list'].ok, false);
  assert.match(results['Printer list'].error, /PowerShell did not finish/);
  for (const name of ['Temporary label station list', 'Manual scan station list', 'Settings and tabs', 'COM ports', 'Configured printer status', 'Temporary label settings', 'Temporary label source status', 'Temporary label access key', 'Temporary label printers']) {
    assert.equal(results[name].ok, true, `${name} should still load`);
  }
  await app.page.close();
});

test('printer discovery returns an error result (main.js shape): useful stderr reaches the page', async (t) => {
  const error = 'PowerShell exited with code 1: Get-CimInstance : Access denied | Retried from a temporary .ps1 file: running scripts is disabled on this system';
  const app = await openApp(t, { 'comBridge.listPrinters': { supported: true, printers: [], error } });
  if (!app) return;
  const state = await app.read();
  assert.deepEqual(state.stationOptions.map((o) => o.text), expectedStationLabels);
  assert.equal(state.tempPrinterError, `Could not read the installed printers: ${error}`);
  assert.equal(state.printerListError, `Could not read the installed printers: ${error}`);
  await app.page.close();
});

test('zero printers: stations still load and the printer dropdown says none were found (not an error)', async (t) => {
  const app = await openApp(t, {
    'comBridge.listPrinters': { supported: true, printers: [], warnings: [], details: 'ok' },
    'tempLabels.getSettings': { settings: { stations: [], layout: DEFAULT_LAYOUT }, defaults: DEFAULT_LAYOUT, status: {} }
  });
  if (!app) return;
  const state = await app.read();
  assert.deepEqual(state.stationOptions.map((o) => o.text), expectedStationLabels);
  assert.deepEqual(state.tempPrinterOptions.map((o) => o.text), ['No printers found']);
  assert.equal(state.tempPrinterError, '');
  assert.equal(byName(app.results)['Temporary label printers'].detail, '0 printer(s)');
  assert.ok(app.results.every((r) => r.ok));
  await app.page.close();
});

test('several sections fail at once - settings file, printers, printer status - the rest still load', async (t) => {
  const app = await openApp(t, {
    'comBridge.listPrinters': { reject: PRINTER_TIMEOUT },
    'comBridge.getPrinterStatus': { reject: 'spooler not running' },
    'comBridge.loadSettings': { reject: 'settings.json is damaged' },
    'tempLabels.getSettings': { reject: 'temp-label-settings.json unreadable' }
  });
  if (!app) return;
  const state = await app.read();
  assert.deepEqual(state.stationOptions.map((o) => o.text), expectedStationLabels);
  assert.match(state.tempLabelError, /Could not load the saved Temporary Data Matrix settings/);
  assert.equal(state.sourceBadge, 'Cached', 'source status is asked for on its own');
  assert.equal(state.keyBadge, 'Not set');
  const failed = app.results.filter((r) => !r.ok).map((r) => r.name).sort();
  assert.deepEqual(failed, ['Configured printer status', 'Printer list', 'Settings and tabs', 'Temporary label settings']);
  await app.page.close();
});

test('Generate Access Key still works when printer discovery has failed', async (t) => {
  const app = await openApp(t, { 'comBridge.listPrinters': { reject: PRINTER_TIMEOUT } });
  if (!app) return;
  await app.page.click('#temp-key-generate-btn');
  await app.page.waitForFunction(() => document.getElementById('temp-key-badge').textContent === 'Set');
  const state = await app.read();
  assert.equal(state.keyButton, 'Replace Access Key');
  assert.equal(await app.page.evaluate(() => document.getElementById('temp-key-hash').value), 'ab'.repeat(32));
  await app.page.close();
});

test('Refresh re-runs ONE discovery and recovers both dropdowns after a failure', async (t) => {
  const app = await openApp(t, { 'comBridge.listPrinters': { reject: PRINTER_TIMEOUT } });
  if (!app) return;
  await app.page.evaluate((printers) => {
    const original = window.comBridge;
    window.comBridge = new Proxy({}, {
      get: (_, method) => (method === 'listPrinters'
        ? () => { window.__calls.push('comBridge.listPrinters'); return Promise.resolve({ supported: true, printers, details: 'ok', warnings: [] }); }
        : original[method])
    });
  }, AWKWARD_PRINTERS);
  await app.page.click('#printer-refresh-btn');
  await app.page.waitForFunction(() => document.getElementById('temp-label-printer-error').hidden);
  const state = await app.read();
  assert.equal(state.listPrintersCalls, 2, 'start-up + one refresh');
  assert.deepEqual(state.tempPrinterOptions.map((o) => o.value), ['', ...AWKWARD_PRINTERS.map((p) => p.name)]);
  assert.deepEqual(state.printerOptions.map((o) => o.value), AWKWARD_PRINTERS.map((p) => p.name));
  assert.equal(state.printerListError, '');
  await app.page.close();
});
