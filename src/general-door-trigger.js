// General Door Code Printing: when a scanner at a configured STATION scans an
// order's general door code ("5698-D", "5626-2-D"), ask the website for that
// order's normal label job and hand it to the existing print-job processor,
// addressed to that station's own printer.
//
// This file decides only WHETHER and WHERE to print. It never renders a
// label, never talks to a printer and never reports job status - all of that
// stays in the one existing pipeline (website job creation ->
// print-job-processor.js -> printer-service.js), injected here as plain
// functions so the whole decision can be tested without Electron, a website
// or a printer.
//
// It is an ADDITIONAL action on a scan. runScanActions() always submits the
// scan to the website first, exactly as before, and nothing in here can stop
// that, throw into the serial read loop, or wait on it.
'use strict';

// <4 digits>[-<call-off>]-D and nothing else: no unit suffix ("-D-01"), no
// frame ("-F"), no delivery ("-DELIV"). The call-off follows the same
// "digit group after a hyphen" convention as delivery-photos/reference.js.
const GENERAL_DOOR_CODE_PATTERN = /^([0-9]{4}(?:-[0-9]{1,3})?)-D$/;
const MAX_CODE_LENGTH = 20;

const DEFAULT_SUPPRESSION_MS = 45 * 1000;

// Returns { order } (e.g. { order: '5626-2' }) or null for anything that is
// not a general door code.
function parseGeneralDoorCode(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  if (!value || value.length > MAX_CODE_LENGTH) return null;
  const match = GENERAL_DOOR_CODE_PATTERN.exec(value);
  return match ? { order: match[1] } : null;
}

// The station_key the job is recorded under on the website. Deliberately NOT
// the plain station key: the existing reconnect recovery
// (recoverPendingJobs, GET /api/print-jobs/pending?station_key=<station>)
// prints whatever it finds on the MAIN printer, and a station-triggered job
// must only ever print on its station's own printer. A distinct key keeps
// these jobs out of that query; recoverPendingGeneralDoorJobs() in main.js
// recovers them with the station's printer instead.
function jobStationKey(stationKey) {
  return `general-door:${stationKey}`;
}

// Submits a scan exactly as before, then gives the trigger its chance. A
// trigger that throws is logged and ignored - it can never undo or delay the
// production scan.
function runScanActions({ postScan, trigger, scan, onTriggerError }) {
  const posted = postScan();
  try {
    trigger.handleScan(scan);
  } catch (err) {
    if (typeof onTriggerError === 'function') onTriggerError(err);
  }
  return posted;
}

// deps:
//   getRule(stationKey)          -> { enabled, printerName } or null (read fresh every time)
//   checkPrinter(printerName)    -> Promise<{ ok } | { ok: false, reason }>
//   createJob({ order, stationKey, portPath, apiUrl }) -> Promise<{ ok, job, apiBase } | { ok: false, error }>
//   enqueue(job, apiBase, { printerName })  - the existing PrintJobProcessor.enqueue
//   logger { info, warn, error }
//   stationLabel(stationKey)     -> display name for logs
//   onOutcome(outcome)           -> UI notification (optional)
//   now()                        -> ms clock (tests)
//   suppressionMs                -> duplicate window
function createGeneralDoorTrigger(deps) {
  const {
    getRule,
    checkPrinter,
    createJob,
    enqueue,
    logger,
    stationLabel = (key) => key,
    onOutcome = () => {},
    now = () => Date.now(),
    suppressionMs = DEFAULT_SUPPRESSION_MS
  } = deps;

  // key -> { at, state: 'pending' | 'done' }. Only a trigger that is still in
  // progress or that actually created a job suppresses a rescan; a failure
  // removes its entry so the operator can simply scan again.
  const recent = new Map();

  function prune(at) {
    for (const [key, entry] of recent) {
      if (at - entry.at >= suppressionMs) recent.delete(key);
    }
  }

  function report(outcome) {
    try {
      onOutcome(outcome);
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

  async function run(ctx, key) {
    const { printerName } = ctx;
    let printer;
    try {
      printer = await checkPrinter(printerName);
    } catch (err) {
      printer = { ok: false, reason: (err && err.message) || String(err) };
    }
    if (!printer || !printer.ok) {
      return fail(ctx, key, (printer && printer.reason) || 'Printer unavailable');
    }

    let created;
    try {
      created = await createJob({ order: ctx.order, stationKey: ctx.stationKey, portPath: ctx.portPath, apiUrl: ctx.apiUrl });
    } catch (err) {
      created = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!created || !created.ok || !created.job || !created.job.jobId) {
      return fail(ctx, key, `Print job not created: ${(created && created.error) || 'no job returned'}`);
    }

    try {
      enqueue(created.job, created.apiBase, { printerName });
    } catch (err) {
      return fail(ctx, key, `Print job ${created.job.jobId} could not be queued: ${(err && err.message) || err}`);
    }

    const entry = recent.get(key);
    if (entry) entry.state = 'done';
    logger.info(`General door label trigger - ${describe(ctx)}, Result: Print job created, Job ID: ${created.job.jobId}`);
    report({ result: 'created', ...ctx, jobId: created.job.jobId });
    return { result: 'created', jobId: created.job.jobId };
  }

  function fail(ctx, key, reason) {
    recent.delete(key);
    logger.warn(`General door label trigger failed - ${describe(ctx)}, Reason: ${reason}`);
    report({ result: 'failed', ...ctx, reason });
    return { result: 'failed', reason };
  }

  // Called once per scan with { value, stationKey, portPath, apiUrl }.
  // Returns synchronously with what it decided; any printing work continues
  // in the background (the returned `done` promise is for tests only and
  // never rejects).
  function handleScan({ value, stationKey, portPath, apiUrl } = {}) {
    const parsed = parseGeneralDoorCode(value);
    if (!parsed) return { result: 'not-a-trigger' };
    if (!stationKey) return { result: 'no-station' };

    let rule;
    try {
      rule = getRule(stationKey);
    } catch (err) {
      logger.warn(`General door label trigger failed - Order: ${parsed.order}, Station: ${stationLabel(stationKey)}, Reason: could not read settings (${err.message})`);
      return { result: 'failed', reason: 'settings unreadable' };
    }
    if (!rule || !rule.enabled) return { result: 'disabled' };

    const ctx = { order: parsed.order, stationKey, portPath: portPath || '', apiUrl: apiUrl || '', printerName: rule.printerName || '' };
    if (!ctx.printerName) {
      return { ...fail(ctx, null, 'No printer is configured for this station'), done: Promise.resolve() };
    }

    const at = now();
    prune(at);
    const key = `${ctx.order}|${stationKey}|${ctx.printerName}`;
    if (recent.has(key)) {
      const ageSeconds = Math.round((at - recent.get(key).at) / 1000);
      logger.info(`General door label trigger suppressed - ${describe(ctx)}, Reason: Duplicate scan within suppression window (${ageSeconds}s ago, window ${Math.round(suppressionMs / 1000)}s)`);
      report({ result: 'suppressed', ...ctx });
      return { result: 'suppressed' };
    }
    recent.set(key, { at, state: 'pending' });

    const done = run(ctx, key).catch((err) => fail(ctx, key, (err && err.message) || String(err)));
    return { result: 'triggered', done };
  }

  return { handleScan, _recent: recent };
}

module.exports = {
  GENERAL_DOOR_CODE_PATTERN,
  DEFAULT_SUPPRESSION_MS,
  parseGeneralDoorCode,
  jobStationKey,
  runScanActions,
  createGeneralDoorTrigger
};
