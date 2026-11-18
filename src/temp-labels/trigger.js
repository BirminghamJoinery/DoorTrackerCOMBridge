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

// Builds the printer check from windows-printer.js's getPrinterStatus:
// exactly the named printer, or a reason it cannot be used. Never the main
// printer, never the Windows default. Also refuses when Windows itself
// reports the printer Offline (statusOffline - an unplugged/switched-off USB
// printer), so a batch is not left in the Windows queue to print
// unexpectedly later.
function createPrinterCheck(getPrinterStatus, platform = process.platform) {
  return async function checkPrinter(printerName) {
    if (!printerName) return { ok: false, reason: 'No printer is configured for this station' };
    const status = await getPrinterStatus(printerName);
    if (!status || !status.supported) return { ok: false, reason: `Printer unavailable - printing is only implemented on Windows (this is ${platform})` };
    if (!status.found) return { ok: false, reason: `Printer unavailable - "${printerName}" was not found on this PC` };
    if (status.offline || status.statusOffline) return { ok: false, reason: `Printer unavailable - Windows reports "${printerName}" as offline (is it switched on and connected by USB?)` };
    return { ok: true };
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
  async function submit(printerName, codes, docName) {
    let printer;
    try {
      printer = await checkPrinter(printerName);
    } catch (err) {
      printer = { ok: false, reason: (err && err.message) || String(err) };
    }
    if (!printer || !printer.ok) return { ok: false, reason: (printer && printer.reason) || 'Printer unavailable' };

    let zpl;
    try {
      zpl = render(codes, getLayout());
    } catch (err) {
      return { ok: false, reason: `Label generation failed: ${(err && err.message) || err}` };
    }

    try {
      await sendRaw(printerName, Buffer.from(zpl, 'ascii'), { docName });
    } catch (err) {
      return { ok: false, reason: `Print submission to "${printerName}" failed: ${(err && err.message) || err}` };
    }
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
