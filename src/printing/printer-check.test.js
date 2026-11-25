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
