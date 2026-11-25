// "Test Temporary Label" (and the scan batches that share its path): a slow
// or failing printer STATUS lookup must not stop or delay a print to a known
// printer, a missing printer is still refused, nothing ever goes to another
// printer, and each stage is logged with its time. No printer, PowerShell or
// Electron is used - the status lookup and raw submission are fakes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const settings = require('./settings');
const { createTempLabelTrigger, createPrinterCheck } = require('./trigger');
const { describePowerShellFailure } = require('../printing/windows-printer');

const PRINTER = 'TOSHIBA B-FV4D';

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

// A trigger whose printer check is createPrinterCheck(getStatus) - the same
// wiring as main.js - and whose raw submission is recorded.
function harness({ getStatus, sendRaw, checkTimeoutMs } = {}) {
  const logger = memoryLogger();
  const sent = [];
  const trigger = createTempLabelTrigger({
    getRule: () => null,
    lookupOrder: () => ({ ok: false, reason: 'not used' }),
    getLayout: () => settings.DEFAULT_LAYOUT,
    checkPrinter: createPrinterCheck(getStatus, 'win32', checkTimeoutMs ? { timeoutMs: checkTimeoutMs } : {}),
    sendRaw: sendRaw || (async (printerName, buffer, options) => {
      sent.push({ printerName, zpl: buffer.toString('ascii'), docName: options.docName });
      return { elapsedMs: 700, stages: ['powershell-ready 250ms', 'compiled 480ms', 'open-printer 490ms', 'start-doc 495ms', `write-printer ${buffer.length}-bytes 500ms`, 'end-doc 510ms'] };
    }),
    logger,
    stationLabel: (key) => key
  });
  return { trigger, logger, sent };
}

const printTest = (h) => h.trigger.printTestLabel({ printerName: PRINTER, code: 'TEST-T-01', stationKey: 'joint_prehung' });

// What windows-printer.js's checkPrinterForPrinting returns for a known
// printer whose Win32_Printer status lookup did not answer in time.
const KNOWN_STATUS_TIMED_OUT = {
  supported: true, found: true, foundBy: 'InstalledPrinters', details: 'timeout', offline: false, statusOffline: false,
  printerStatus: null, extendedStatus: null, namesMs: 45, detailsMs: 4003, elapsedMs: 6800,
  warnings: ['Printer status (Win32_Printer) did not answer within 4s.']
};

// A PowerShell run stopped by its time limit, exactly as windows-printer.js
// describes one.
// `stages` is what sendRawData adds; the status check has none.
function powerShellTimeout({ stages, timeoutMs = 15000 } = {}) {
  const err = new Error('Command failed');
  err.killed = true;
  err.signal = 'SIGTERM';
  const described = describePowerShellFailure({
    err, stdout: (stages || []).map((s) => `STAGE ${s}`).join('\r\n'), stderr: '', timeoutMs, elapsedMs: timeoutMs + 12,
    command: 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <temporary .ps1>'
  });
  if (stages) described.diagnostics.stages = stages;
  return described;
}

test('known printer + status query timeout: the test label is still sent, to that printer, with a warning', async () => {
  const h = harness({ getStatus: async () => KNOWN_STATUS_TIMED_OUT });
  assert.deepEqual(await printTest(h), { ok: true, code: 'TEST-T-01' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].printerName, PRINTER);
  assert.match(h.sent[0].zpl, /\^FDTEST-T-01\^FS/, 'label contents unchanged');
  assert.match(h.logger.text(), /WARN Temporary label print "Temporary Labels - TEST-T-01" on "TOSHIBA B-FV4D" - step 1\/3 printer check incomplete after \d+ms: "TOSHIBA B-FV4D" exists but its status could not be read \(Printer status \(Win32_Printer\) did not answer within 4s\.\) - sending anyway/);
  assert.match(h.logger.text(), /Temporary test label - Station: joint_prehung, Printer: TOSHIBA B-FV4D, Code: TEST-T-01, Result: Submitted/);
});

test('raw print still attempted when status is unavailable: lookup failed, PowerShell timed out, or threw', async () => {
  for (const getStatus of [
    async () => ({ ...KNOWN_STATUS_TIMED_OUT, details: 'failed', warnings: ['Printer status (Win32_Printer): Generic failure'] }),
    async () => { throw powerShellTimeout({ timeoutMs: 10000 }); },
    async () => { throw new Error('spooler busy'); }
  ]) {
    const h = harness({ getStatus });
    assert.equal((await printTest(h)).ok, true);
    assert.deepEqual(h.sent.map((s) => s.printerName), [PRINTER]);
  }
});

test('a status lookup that never answers does not hold up the test print', async () => {
  const h = harness({ getStatus: () => new Promise(() => {}), checkTimeoutMs: 150 });
  const started = Date.now();
  const result = await printTest(h);
  const took = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(h.sent.length, 1);
  assert.ok(took < 2000, `took ${took}ms`);
  assert.match(h.logger.text(), /Printer status could not be checked \(the printer check did not finish within 0s\) - sending anyway; Windows refuses the job if "TOSHIBA B-FV4D" does not exist/);
});

test('the test-print path never waits the old 15s on the status check', () => {
  const trigger = fs.readFileSync(nodePath.join(__dirname, 'trigger.js'), 'utf8');
  const limit = Number(trigger.match(/DEFAULT_PRINTER_CHECK_TIMEOUT_MS = (\d+) \* 1000/)[1]) * 1000;
  assert.ok(limit < 15000);
  const main = fs.readFileSync(nodePath.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /createPrinterCheck\(\(name\) => windowsPrinter\.checkPrinterForPrinting\(name\)\)/, 'temporary labels use the bounded check');
  assert.doesNotMatch(main, /createPrinterCheck\(\(name\) => windowsPrinter\.getPrinterStatus/);
});

test('wrong/missing printer is still refused - nothing sent, no fallback to another printer', async () => {
  for (const status of [
    { supported: true, found: false, details: 'not-found', warnings: [] },
    { supported: true, found: false, details: 'timeout', warnings: ['Printer status (Win32_Printer) did not answer within 4s.'] }
  ]) {
    const h = harness({ getStatus: async () => status });
    const result = await printTest(h);
    assert.equal(result.ok, false);
    assert.match(result.error, /Printer unavailable - "TOSHIBA B-FV4D" was not found on this PC/);
    assert.equal(h.sent.length, 0);
    assert.match(h.logger.text(), /WARN .* step 1\/3 printer check refused after \d+ms: Printer unavailable - "TOSHIBA B-FV4D" was not found on this PC/);
  }
  // Status unknown: the job goes to EXACTLY the configured name, and
  // Windows' own refusal of a missing printer is reported, not worked around.
  const sent = [];
  const h = harness({
    getStatus: async () => { throw new Error('status unavailable'); },
    sendRaw: async (printerName) => { sent.push(printerName); throw new Error('Exception calling "SendBytesToPrinter": "OpenPrinter failed"'); }
  });
  const result = await printTest(h);
  assert.equal(result.ok, false);
  assert.match(result.error, /Print submission to "TOSHIBA B-FV4D" failed: .*OpenPrinter failed/);
  assert.deepEqual(sent, [PRINTER]);
});

test('offline (as Windows reports it, when it does answer) is still refused, with the raw status values', async () => {
  for (const status of [
    { supported: true, found: true, details: 'ok', offline: true, statusOffline: false, printerStatus: 3, extendedStatus: 2 },
    { supported: true, found: true, details: 'ok', offline: false, statusOffline: true, printerStatus: 1, extendedStatus: 7 }
  ]) {
    const h = harness({ getStatus: async () => status });
    const result = await printTest(h);
    assert.equal(result.ok, false);
    assert.match(result.error, /Windows reports "TOSHIBA B-FV4D" as offline \(PrinterStatus \d, ExtendedPrinterStatus \d, WorkOffline (on|off)\)/);
    assert.equal(h.sent.length, 0);
  }
});

test('a PowerShell timeout in the raw submission is logged with the stage it stopped at', async () => {
  const h = harness({
    getStatus: async () => ({ supported: true, found: true, foundBy: 'InstalledPrinters', details: 'ok', offline: false, statusOffline: false, printerStatus: 3, extendedStatus: 2, namesMs: 40, detailsMs: 300, elapsedMs: 2900 }),
    sendRaw: async () => { throw powerShellTimeout({ stages: ['powershell-ready 300ms', 'compiled 900ms', 'open-printer 910ms'] }); }
  });
  const result = await printTest(h);
  assert.equal(result.ok, false);
  assert.match(result.error, /Print submission to "TOSHIBA B-FV4D" failed: PowerShell did not finish within 15s and was stopped/);
  const log = h.logger.text();
  assert.match(log, /INFO .* step 1\/3 printer check passed in \d+ms \(found via InstalledPrinters, status ok, PrinterStatus 3\/ExtendedPrinterStatus 2, names 40ms, status 300ms, PowerShell total 2900ms\)\./);
  assert.match(log, /INFO .* step 2\/3 ZPL generated in \d+ms \(1 label\(s\), \d+ bytes\)\./);
  assert.match(log, /INFO .* step 3\/3 raw submission started\./);
  assert.match(log, /WARN .* step 3\/3 raw submission failed after \d+ms: PowerShell did not finish within 15s and was stopped \[command: powershell\.exe .* -File <temporary \.ps1>; stopped by the time limit; PowerShell ran 15012ms; last steps reached: powershell-ready 300ms, compiled 900ms, open-printer 910ms\]/);
});

test('a PowerShell timeout in the status check is logged with its diagnostics, and the print continues', async () => {
  const h = harness({ getStatus: async () => { throw powerShellTimeout({ timeoutMs: 10000 }); } });
  assert.equal((await printTest(h)).ok, true);
  assert.match(h.logger.text(), /WARN .* step 1\/3 printer check incomplete after \d+ms: Printer status could not be checked \(PowerShell did not finish within 10s and was stopped\) - sending anyway.* \[command: powershell\.exe .*; stopped by the time limit; PowerShell ran 10012ms\]/);
});

test('a successful print logs every stage, in order, with timings from inside PowerShell', async () => {
  const h = harness({ getStatus: async () => ({ supported: true, found: true, details: 'ok', offline: false, statusOffline: false }) });
  assert.equal((await printTest(h)).ok, true);
  const steps = h.logger.lines.map(([, m]) => m).filter((m) => m.startsWith('Temporary label print')).map((m) => m.replace(/^.* - (step \S+ [a-zA-Z ]+?)( in| started|\.).*$/, '$1'));
  assert.deepEqual(steps, ['step 1/3 printer check', 'step 1/3 printer check passed', 'step 2/3 ZPL generated', 'step 3/3 raw submission', 'step 3/3 raw submission accepted by Windows']);
  assert.match(h.logger.text(), /accepted by Windows in \d+ms \(inside PowerShell: powershell-ready 250ms, compiled 480ms, open-printer 490ms, start-doc 495ms, write-printer \d+-bytes 500ms, end-doc 510ms\)\. Total \d+ms\./);
});
