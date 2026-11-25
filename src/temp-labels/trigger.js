// Temporary Data Matrix Printing: when a scanner at a configured STATION scans
// an order's general door code ("5698-D", "5626-2-D"), print that order's
// temporary labels (5698-T-01, 5698-T-02, ...) on the station's own printer,
// quantity from the local source cache (source-cache.js).
//
// An ADDITIONAL action on a scan, run by scan-actions.js's runScanActions()
// AFTER the scan has been submitted to the website exactly as before. handleScan() decides synchronously and does the printing in the
// background; nothing here can throw into the serial read loop, wait on it,
// or change the production scan's outcome.
//
// No website print job, no job id, no PrintJobProcessor: the printer, the
// source lookup and the raw submission are injected so the whole flow is
// tested without Electron, a network or a printer.
'use strict';

const { parseTempLabelTrigger, generateTempCodes, describeCodeRange, normalizeTestCode } = require('./codes');
const { buildTempBatchZpl } = require('./zpl');

const DEFAULT_SUPPRESSION_MS = 45 * 1000;

// What a batch is called in the Windows print queue: "Temporary Labels - 5698"
// (a test print: "Temporary Labels - TEST-T-01"). Existing delivery/main
// printer jobs keep their own name.
function tempJobName(orderOrCode) {
  return `Temporary Labels - ${orderOrCode}`;
}

// Runs tasks one at a time, in the order they were queued. Every temporary
// batch and test print goes through ONE of these, so two batches are never
// submitted at the same time and always reach Windows in scan order. A
// failing task never blocks the ones after it.
function createSerialQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  function run(task) {
    pending += 1;
    const result = tail.then(task).finally(() => { pending -= 1; });
    tail = result.catch(() => {}); // the tail itself never rejects
    return result;
  }
  return { run, get pending() { return pending; } };
}

// How long the printer check may take before the print goes ahead without
// it (see createPrinterCheck). windows-printer.js's own check limits itself
// to well under this; this is the backstop.
const DEFAULT_PRINTER_CHECK_TIMEOUT_MS = 10 * 1000;

function errorText(err) {
  return (err && err.message) || String(err);
}

// PowerShell's own facts about a failed run (windows-printer.js puts them on
// err.diagnostics): whether it was stopped by the time limit, exit code,
// elapsed time, the last steps it reported and its error output. Printer
// names and temp-file paths only - nothing secret passes through here.
function describeDiagnostics(d) {
  if (!d || typeof d !== 'object') return '';
  const parts = [];
  if (d.command) parts.push(`command: ${d.command}`);
  if (d.timedOut) parts.push('stopped by the time limit');
  if (d.exitCode != null) parts.push(`exit code ${d.exitCode}`);
  if (d.elapsedMs != null) parts.push(`PowerShell ran ${d.elapsedMs}ms`);
  if (Array.isArray(d.stages)) parts.push(d.stages.length ? `last steps reached: ${d.stages.join(', ')}` : 'no steps reached');
  if (d.stderr) parts.push(`stderr: ${String(d.stderr).slice(0, 500)}`);
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

// What the printer check found, for the step-1 log line.
function describeCheck(result) {
  if (!result) return '';
  const s = result.status;
  const parts = [];
  if (s && s.foundBy) parts.push(`found via ${s.foundBy}`);
  if (s && s.details) parts.push(`status ${s.details}`);
  if (s && s.printerStatus != null) parts.push(`PrinterStatus ${s.printerStatus}/ExtendedPrinterStatus ${s.extendedStatus}`);
  if (s && s.namesMs != null) parts.push(`names ${s.namesMs}ms, status ${s.detailsMs}ms, PowerShell total ${s.elapsedMs}ms`);
  const diag = describeDiagnostics(result.error && result.error.diagnostics);
  return (parts.length ? ` (${parts.join(', ')})` : '') + diag;
}

// Builds the printer check from windows-printer.js's checkPrinterForPrinting
// (or anything returning the same shape - getPrinterStatus's older shape,
// with no `details`, reads as fully checked): exactly the named printer, or
// a reason it cannot be used. Never the main printer, never the Windows
// default.
//
// Refuses when:
//   - the printer is not found on this PC, or
//   - Windows' status was read and reports it Offline (WorkOffline, or
//     PrinterStatus/ExtendedPrinterStatus 7 - an unplugged/switched-off USB
//     printer), so a batch is not left in the Windows queue to print
//     unexpectedly later.
// Goes ahead, with a `warning`, when the printer exists but its detailed
// status could not be read (details 'timeout' or 'failed'), or when the
// check itself failed or took longer than `timeoutMs` - a slow status query
// must never stop a print to a known printer. Sending can still never reach
// a different printer: the raw submission opens exactly this name and
// Windows refuses it if no such printer exists.
//
// Resolves { ok, reason?, warning?, status?, error?, ms }; never rejects.
function createPrinterCheck(getStatus, platform = process.platform, { timeoutMs = DEFAULT_PRINTER_CHECK_TIMEOUT_MS, now = () => Date.now() } = {}) {
  return async function checkPrinter(printerName) {
    const started = now();
    const done = (result) => ({ ...result, ms: now() - started });
    if (!printerName) return done({ ok: false, reason: 'No printer is configured for this station' });

    let timer;
    let status;
    try {
      status = await Promise.race([
        Promise.resolve().then(() => getStatus(printerName)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the printer check did not finish within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
          if (timer.unref) timer.unref();
        })
      ]);
    } catch (err) {
      return done({
        ok: true,
        warning: `Printer status could not be checked (${errorText(err)}) - sending anyway; Windows refuses the job if "${printerName}" does not exist`,
        error: err
      });
    } finally {
      clearTimeout(timer);
    }

    if (!status || !status.supported) return done({ ok: false, reason: `Printer unavailable - printing is only implemented on Windows (this is ${platform})`, status });
    if (!status.found) return done({ ok: false, reason: `Printer unavailable - "${printerName}" was not found on this PC`, status });
    const details = status.details || 'ok';
    if (details === 'ok') {
      if (status.offline || status.statusOffline) {
        const raw = status.printerStatus != null ? ` (PrinterStatus ${status.printerStatus}, ExtendedPrinterStatus ${status.extendedStatus}, WorkOffline ${status.offline ? 'on' : 'off'})` : '';
        return done({ ok: false, reason: `Printer unavailable - Windows reports "${printerName}" as offline${raw} (is it switched on and connected by USB?)`, status });
      }
      return done({ ok: true, status });
    }
    const why = (status.warnings && status.warnings.length ? status.warnings.join(' ') : details);
    return done({ ok: true, status, warning: `"${printerName}" exists but its status could not be read (${why}) - sending anyway` });
  };
}

// deps:
//   getRule(stationKey)        -> { enabled, printerName } or null (read fresh every scan)
//   lookupOrder(order)         -> { ok, qty } | { ok: false, reason } (local cache)
//   getLayout()                -> label layout (read fresh every print)
//   checkPrinter(printerName)  -> Promise<{ ok } | { ok: false, reason }>
//   sendRaw(printerName, Buffer, { docName }) -> Promise (Windows raw submission;
//                                docName is the job name in the Windows queue)
//   render(codes, layout)      -> ZPL string (defaults to the real renderer)
//   logger { info, warn, error }
//   stationLabel(stationKey)   -> display name for logs
//   onOutcome(outcome)         -> UI notification (optional)
//   now()                      -> ms clock (tests)
//   suppressionMs              -> duplicate window
//   queue                      -> a createSerialQueue() (tests may share one)
function createTempLabelTrigger(deps) {
  const {
    getRule,
    lookupOrder,
    getLayout,
    checkPrinter,
    sendRaw,
    render = buildTempBatchZpl,
    logger,
    stationLabel = (key) => key,
    onOutcome = () => {},
    now = () => Date.now(),
    suppressionMs = DEFAULT_SUPPRESSION_MS,
    queue = createSerialQueue()
  } = deps;

  // key (order|station|printer) -> { at, state: 'pending' | 'done' }. Only a
  // batch still in progress or one Windows accepted suppresses a rescan; a
  // failure removes its entry so the operator can simply scan again. Nothing
  // is kept beyond the window - there is no permanent "already printed".
  const recent = new Map();

  function prune(at) {
    for (const [key, entry] of recent) {
      if (at - entry.at >= suppressionMs) recent.delete(key);
    }
  }

  function report(outcome) {
    try {
      onOutcome({ ...outcome, at: new Date(now()).toISOString() });
    } catch {
      // UI notification only
    }
  }

  function describe({ order, stationKey, portPath, printerName }) {
    const parts = [`Order: ${order}`, `Station: ${stationLabel(stationKey)}`];
    if (portPath) parts.push(`COM: ${portPath}`);
    if (printerName) parts.push(`Printer: ${printerName}`);
    return parts.join(', ');
  }

  function fail(ctx, key, reason, { notPrinted = false } = {}) {
    if (key) recent.delete(key);
    const heading = notPrinted ? 'Temporary labels not printed' : 'Temporary label batch failed';
    logger.warn(`${heading} - ${describe(ctx)}, Reason: ${reason}`);
    report({ result: 'failed', ...ctx, reason });
    return { result: 'failed', reason };
  }

  // Printer check, render and raw submission for one batch - always inside
  // the serial queue, so the printer status is checked right before sending.
  // Each stage is logged as it starts and ends, with its elapsed time, so a
  // log shows exactly which stage a print stopped in.
  async function submit(printerName, codes, docName) {
    const stage = `Temporary label print "${docName}" on "${printerName}"`;
    const began = now();

    logger.info(`${stage} - step 1/3 printer check started.`);
    let printer;
    try {
      printer = await checkPrinter(printerName);
    } catch (err) {
      printer = { ok: false, reason: errorText(err), error: err };
    }
    const checkMs = printer && typeof printer.ms === 'number' ? printer.ms : now() - began;
    if (!printer || !printer.ok) {
      const reason = (printer && printer.reason) || 'Printer unavailable';
      logger.warn(`${stage} - step 1/3 printer check refused after ${checkMs}ms: ${reason}${describeCheck(printer)}`);
      return { ok: false, reason };
    }
    if (printer.warning) {
      logger.warn(`${stage} - step 1/3 printer check incomplete after ${checkMs}ms: ${printer.warning}${describeCheck(printer)}`);
    } else {
      logger.info(`${stage} - step 1/3 printer check passed in ${checkMs}ms${describeCheck(printer)}.`);
    }

    const renderStarted = now();
    let zpl;
    try {
      zpl = render(codes, getLayout());
    } catch (err) {
      const reason = `Label generation failed: ${errorText(err)}`;
      logger.warn(`${stage} - step 2/3 ${reason}`);
      return { ok: false, reason };
    }
    const bytes = Buffer.from(zpl, 'ascii');
    logger.info(`${stage} - step 2/3 ZPL generated in ${now() - renderStarted}ms (${codes.length} label(s), ${bytes.length} bytes).`);

    const sendStarted = now();
    logger.info(`${stage} - step 3/3 raw submission started.`);
    let sent;
    try {
      sent = await sendRaw(printerName, bytes, { docName });
    } catch (err) {
      const reason = `Print submission to "${printerName}" failed: ${errorText(err)}`;
      logger.warn(`${stage} - step 3/3 raw submission failed after ${now() - sendStarted}ms: ${errorText(err)}${describeDiagnostics(err && err.diagnostics)}`);
      return { ok: false, reason };
    }
    const steps = sent && Array.isArray(sent.stages) && sent.stages.length ? ` (inside PowerShell: ${sent.stages.join(', ')})` : '';
    logger.info(`${stage} - step 3/3 raw submission accepted by Windows in ${now() - sendStarted}ms${steps}. Total ${now() - began}ms.`);
    return { ok: true };
  }

  async function run(ctx, key) {
    const found = lookupOrder(ctx.order);
    if (!found || !found.ok) return fail(ctx, key, (found && found.reason) || 'Order not found in temporary-label source', { notPrinted: true });

    let codes;
    try {
      codes = generateTempCodes(ctx.order, found.qty);
    } catch (err) {
      return fail(ctx, key, `Invalid quantity: ${err.message}`, { notPrinted: true });
    }
    const batch = { ...ctx, quantity: codes.length, firstCode: codes[0], lastCode: codes[codes.length - 1] };

    const sent = await queue.run(() => submit(ctx.printerName, codes, tempJobName(ctx.order)));
    if (!sent.ok) return fail(batch, key, sent.reason);

    const entry = recent.get(key);
    if (entry) entry.state = 'done';
    logger.info(`Temporary label batch triggered - ${describe(ctx)}, Quantity: ${codes.length}, Codes: ${describeCodeRange(codes)}, Result: Submitted`);
    report({ result: 'submitted', ...batch });
    return { result: 'submitted', codes };
  }

  // Called once per scan with { value, stationKey, portPath }. Returns
  // synchronously with what it decided; printing continues in the background
  // (the returned `done` promise is for tests only and never rejects).
  function handleScan({ value, stationKey, portPath } = {}) {
    const parsed = parseTempLabelTrigger(value);
    if (!parsed) return { result: 'not-a-trigger' };
    if (!stationKey) return { result: 'no-station' };

    let rule;
    try {
      rule = getRule(stationKey);
    } catch (err) {
      logger.warn(`Temporary label batch failed - Order: ${parsed.order}, Station: ${stationLabel(stationKey)}, Reason: could not read settings (${err.message})`);
      return { result: 'failed', reason: 'settings unreadable' };
    }
    if (!rule || !rule.enabled) return { result: 'disabled' };

    const ctx = { order: parsed.order, stationKey, portPath: portPath || '', printerName: rule.printerName || '' };
    if (!ctx.printerName) return { ...fail(ctx, null, 'No printer is configured for this station'), done: Promise.resolve() };

    const at = now();
    prune(at);
    const key = `${ctx.order}|${stationKey}|${ctx.printerName}`;
    if (recent.has(key)) {
      const ageSeconds = Math.round((at - recent.get(key).at) / 1000);
      logger.info(`Temporary label batch suppressed - ${describe(ctx)}, Reason: Duplicate scan within ${Math.round(suppressionMs / 1000)} seconds (first scan ${ageSeconds}s ago)`);
      report({ result: 'suppressed', ...ctx });
      return { result: 'suppressed' };
    }
    recent.set(key, { at, state: 'pending' });

    const done = run(ctx, key).catch((err) => fail(ctx, key, (err && err.message) || String(err)));
    return { result: 'triggered', done };
  }

  // ONE label with an operator-typed code, for positioning/sizing on real
  // stock. Same queue, printer check, renderer and submission as a scan;
  // no source lookup and no duplicate suppression.
  async function printTestLabel({ printerName, code, stationKey } = {}) {
    const normalized = normalizeTestCode(code);
    if (!normalized) return { ok: false, error: 'Enter a test code using capital letters, digits and hyphens only (e.g. TEST-T-01).' };
    if (!printerName) return { ok: false, error: 'This station has no printer configured.' };
    const sent = await queue.run(() => submit(printerName, [normalized], tempJobName(normalized)));
    const where = `Station: ${stationKey ? stationLabel(stationKey) : '-'}, Printer: ${printerName}, Code: ${normalized}`;
    if (!sent.ok) {
      logger.warn(`Temporary test label failed - ${where}, Reason: ${sent.reason}`);
      return { ok: false, error: sent.reason };
    }
    logger.info(`Temporary test label - ${where}, Result: Submitted`);
    return { ok: true, code: normalized };
  }

  return { handleScan, printTestLabel, queue, _recent: recent };
}

module.exports = { DEFAULT_SUPPRESSION_MS, tempJobName, createSerialQueue, createPrinterCheck, createTempLabelTrigger };
