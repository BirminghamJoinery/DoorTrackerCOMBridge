// The bounded printer check used by Temporary Data Matrix Printing
// (checkPrinterForPrinting) and the raw sender's progress lines
// (sendRawData). Real-PowerShell checks run only on Windows and never print
// anything: the only raw submission here is to a printer that does not exist,
// which Windows refuses at OpenPrinter.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const windowsPrinter = require('./windows-printer');
const {
  checkPrinterForPrinting,
  buildPrinterCheckScript,
  parseSendStages,
  runPowerShellCommand,
  sendRawData,
  listPrinters,
  PRINTER_CHECK_DETAILS_WAIT_MS,
  PRINTER_CHECK_TIMEOUT_MS
} = windowsPrinter;

const IS_WINDOWS = process.platform === 'win32';
const MISSING = 'COM Bridge test printer that does not exist 7f3a';

const AWKWARD_NAMES = [
  'TOSHIBA B-FV4D',
  'TSC TE210 #2',
  '\\\\DESKTOP-5OHKE65.bjltd.local\\TOSHIBA B-FV4 (203 dpi)',
  'O\'Brien "Label" & Co, #3',
  'semi;colon [brackets] {braces} $(Get-Date) `tick',
  'Étiquette – Zebra ü'
];

const fakeRun = (result) => async () => JSON.stringify(result);

test('the printer name reaches the script base64-encoded - no name can change what the script does', () => {
  for (const name of AWKWARD_NAMES) {
    const script = buildPrinterCheckScript(name);
    const b64 = script.match(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/)[1];
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), name);
    if (/['"$`;]/.test(name)) assert.ok(!script.includes(name), `raw name not in script: ${name}`);
  }
});

test('the check looks up ONE printer by key and bounds the status wait well inside the overall limit', () => {
  const script = buildPrinterCheckScript('X');
  assert.match(script, /PrinterSettings\]::InstalledPrinters/);
  assert.match(script, /New-CimInstance -ClassName Win32_Printer -Property @\{ DeviceID = \$n \} -Key DeviceID -ClientOnly/);
  assert.doesNotMatch(script, /-Filter/, 'no WQL query over every printer');
  assert.match(script, new RegExp(`WaitOne\\(${PRINTER_CHECK_DETAILS_WAIT_MS}\\)`));
  assert.match(script, /\[Environment\]::Exit\(0\)/, 'exits even if the status lookup is still stuck');
  assert.ok(PRINTER_CHECK_DETAILS_WAIT_MS + 3000 < PRINTER_CHECK_TIMEOUT_MS);
  assert.ok(PRINTER_CHECK_TIMEOUT_MS < 15000, 'never the old 15s');
});

test('known printer + status lookup timed out: found, status not trusted either way', async () => {
  const r = await checkPrinterForPrinting('TOSHIBA B-FV4D', {
    platform: 'win32',
    run: fakeRun({ found: true, foundBy: 'InstalledPrinters', details: 'timeout', isOffline: false, printerStatus: null, extendedStatus: null, namesMs: 40, detailsMs: 4002, warnings: ['Printer status (Win32_Printer) did not answer within 4s.'] })
  });
  assert.equal(r.supported, true);
  assert.equal(r.found, true);
  assert.equal(r.details, 'timeout');
  assert.equal(r.offline, false);
  assert.equal(r.statusOffline, false);
  assert.deepEqual(r.warnings, ['Printer status (Win32_Printer) did not answer within 4s.']);
});

test('status read: WorkOffline and PrinterStatus/ExtendedPrinterStatus 7 are reported as before', async () => {
  const offline = await checkPrinterForPrinting('P', { platform: 'win32', run: fakeRun({ found: true, details: 'ok', isOffline: true, printerStatus: 3, extendedStatus: 2 }) });
  assert.equal(offline.offline, true);
  const statusOffline = await checkPrinterForPrinting('P', { platform: 'win32', run: fakeRun({ found: true, details: 'ok', isOffline: false, printerStatus: 1, extendedStatus: 7 }) });
  assert.equal(statusOffline.statusOffline, true);
  const ready = await checkPrinterForPrinting('P', { platform: 'win32', run: fakeRun({ found: true, details: 'ok', isOffline: false, printerStatus: 3, extendedStatus: 2 }) });
  assert.equal(ready.offline || ready.statusOffline, false);
});

test('a missing printer is reported as not found', async () => {
  const r = await checkPrinterForPrinting(MISSING, { platform: 'win32', run: fakeRun({ found: false, foundBy: null, details: 'not-found', isOffline: false, warnings: [] }) });
  assert.equal(r.found, false);
});

// The upstairs test laptop's lists, from its COM Bridge log (2026-11-26):
// with the USB queue (09:26:24), and while it had been removed (09:18:15).
const TOSHIBA = 'TOSHIBA B-FV4 (203 dpi)';
const UNC_TOSHIBA = '\\\\DESKTOP-5OHKE65.bjltd.local\\TOSHIBA B-FV4 (203 dpi)';
const LAPTOP_NOW = [TOSHIBA, 'ZDesigner GK420d', 'TSC TE210 #2', 'TSC TE210', 'SHARP MX-4060N (7800736500)', 'SHARP MX-3050N PCL6', 'OneNote (Desktop)', 'Microsoft Print to PDF', UNC_TOSHIBA];
const LAPTOP_0918 = LAPTOP_NOW.filter((n) => n !== TOSHIBA);
// What the current script prints (compact JSON, one line).
const scriptOutput = (names, extra = {}) => JSON.stringify({ names, namesOk: true, keyFound: false, details: 'ok', isOffline: false, printerStatus: 3, extendedStatus: 2, namesMs: 45, detailsMs: 250, warnings: [], ...extra });

test('regression: "TOSHIBA B-FV4 (203 dpi)" is found in the list Windows returns, and the comparison is reported', async () => {
  const r = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput(LAPTOP_NOW, { keyFound: true }) });
  assert.equal(r.found, true);
  assert.equal(r.foundBy, 'InstalledPrinters');
  assert.equal(r.nameMatch.how, 'exact');
  assert.equal(r.nameMatch.name, TOSHIBA);
  assert.equal(r.requested, TOSHIBA);
  assert.deepEqual(r.installedNames, LAPTOP_NOW);
  assert.equal(r.offline || r.statusOffline, false);
});

test('the script output may carry a BOM, CR/LF or a stray line around the JSON - still found', async () => {
  for (const wrap of [
    (j) => `﻿${j}\r\n`,
    (j) => `\r\n${j}\r\n\r\n`,
    (j) => `WARNING: something unrelated\r\n${j}`,
    (j) => `${j}\r\nPS> `
  ]) {
    const r = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => wrap(scriptOutput(LAPTOP_NOW)) });
    assert.equal(r.found, true);
  }
  // Each listed name with an artefact of its own: still exactly this printer.
  const r = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput([`${TOSHIBA}\r\n`, 'TSC TE210']) });
  assert.equal(r.found, true);
  assert.equal(r.nameMatch.cleaned, true);
  // One printer only: ConvertTo-Json still gives an array, but a bare string is read too.
  assert.equal((await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput(TOSHIBA) })).found, true);
});

test('not in the list: not found, unless Win32_Printer has exactly that name; look-alikes are never used', async () => {
  const missing = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput(LAPTOP_0918, { details: 'not-found', printerStatus: null, extendedStatus: null }) });
  assert.equal(missing.found, false);
  assert.deepEqual(missing.nameMatch.similar, [UNC_TOSHIBA]);
  const byKey = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput(LAPTOP_0918, { keyFound: true }) });
  assert.equal(byKey.found, true);
  assert.equal(byKey.foundBy, 'Win32_Printer');
  for (const other of ['TOSHIBA B-FV4 (203 dpi) (Copy 1)', 'TOSHIBA B-FV4', 'TOSHIBA B-FV4 (300 dpi)']) {
    const r = await checkPrinterForPrinting(TOSHIBA, { platform: 'win32', run: async () => scriptOutput([other]) });
    assert.equal(r.found, false, other);
  }
});

test('off Windows, or with no name, PowerShell is never run', async () => {
  const run = () => { throw new Error('must not run'); };
  assert.equal((await checkPrinterForPrinting('P', { platform: 'darwin', run })).supported, false);
  assert.equal((await checkPrinterForPrinting('', { platform: 'win32', run })).found, false);
});

test('output that is not JSON is a clear error', async () => {
  await assert.rejects(checkPrinterForPrinting('P', { platform: 'win32', run: async () => 'garbage' }), /Printer check returned output that is not JSON: garbage/);
});

test('the raw sender\'s progress lines are picked out of its output', () => {
  assert.deepEqual(parseSendStages('STAGE powershell-ready 250ms\r\nSTAGE compiled 480ms\r\nSTAGE open-printer 490ms\r\nOK\r\n'), ['powershell-ready 250ms', 'compiled 480ms', 'open-printer 490ms']);
  assert.deepEqual(parseSendStages(''), []);
  assert.deepEqual(parseSendStages(undefined), []);
});

test('Windows: real check - installed printers are found, a missing one is not, awkward names never break it', { skip: !IS_WINDOWS && 'Windows only', timeout: 180000 }, async () => {
  const installed = (await listPrinters()).printers.map((p) => p.name);
  if (installed.length > 0) {
    const r = await checkPrinterForPrinting(installed[0]);
    assert.equal(r.found, true, installed[0]);
    assert.equal(r.foundBy, 'InstalledPrinters');
    assert.ok(['ok', 'failed', 'timeout', 'not-found'].includes(r.details));
    assert.ok(r.elapsedMs < PRINTER_CHECK_TIMEOUT_MS);
  }
  for (const name of [MISSING, ...AWKWARD_NAMES.filter((n) => !installed.includes(n))]) {
    const r = await checkPrinterForPrinting(name);
    assert.equal(r.found, false, name);
  }
});

test('Windows: real Windows PowerShell 5.1 output - every installed name is listed byte-for-byte and found exactly, including "TOSHIBA B-FV4 (203 dpi)" when installed', { skip: !IS_WINDOWS && 'Windows only', timeout: 180000 }, async (t) => {
  const installed = (await listPrinters()).printers.map((p) => p.name);
  if (installed.length === 0) { t.skip('no printers installed'); return; }
  const r = await checkPrinterForPrinting(installed[0]);
  assert.ok(Array.isArray(r.installedNames));
  for (const n of r.installedNames) {
    assert.ok(installed.includes(n), `discovery lists the same name: ${JSON.stringify(n)}`);
    assert.equal(n, n.trim(), `no padding/CR/LF: ${JSON.stringify(n)}`);
  }
  assert.equal(r.nameMatch.how, 'exact');
  if (installed.includes(TOSHIBA)) {
    const toshiba = await checkPrinterForPrinting(TOSHIBA);
    assert.equal(toshiba.found, true);
    assert.equal(toshiba.foundBy, 'InstalledPrinters');
    assert.equal(toshiba.nameMatch.how, 'exact');
  }
});

test('Windows: a hung Win32_Printer status lookup still returns "found" within the bound', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async (t) => {
  const installed = (await listPrinters()).printers.map((p) => p.name);
  if (installed.length === 0) { t.skip('no printers installed'); return; }
  const started = Date.now();
  const r = await checkPrinterForPrinting(installed[0], {
    // The real script, with the status lookup made to hang like a printer
    // driver that never answers.
    run: (script) => runPowerShellCommand(script.replace('Get-CimInstance -InputObject $key', 'Start-Sleep -Seconds 120; Get-CimInstance -InputObject $key'), { timeoutMs: PRINTER_CHECK_TIMEOUT_MS })
  });
  assert.equal(r.found, true);
  assert.equal(r.details, 'timeout');
  assert.match(r.warnings.join(' '), /did not answer within 4s/);
  assert.ok(Date.now() - started < PRINTER_CHECK_TIMEOUT_MS, `took ${Date.now() - started}ms`);
});

test('Windows: a raw submission to a printer that does not exist is refused by Windows - nothing printed, no fallback', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async () => {
  await assert.rejects(sendRawData(MISSING, Buffer.from('^XA^XZ', 'ascii'), { docName: 'COM Bridge test' }), (err) => {
    assert.match(err.message, /OpenPrinter failed/);
    assert.deepEqual(err.diagnostics.stages.map((s) => s.split(' ')[0]), ['powershell-ready', 'compiled'], 'stopped at OpenPrinter');
    return true;
  });
});
