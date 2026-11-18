// The temporary-label source: Order Number -> Temp Label Qty, read from the
// Google Sheet (through the website's GET /api/temp-labels, which uses the
// website's existing Google service account - this app holds no Google
// credentials) and kept in a LOCAL cache that every scan reads.
//
//   Google Sheet -> website -> periodic/manual refresh -> local cache -> scans
//
// A scan never waits on the network. A refresh that fails keeps the last
// good cache in memory AND on disk; only a successful refresh replaces it.
// The cache file (temp-labels-cache.json in userData) is read at start-up, so
// printing works after a restart before the internet is back.
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const { normalizeOrderNumber, parseQuantity } = require('./codes');

const CACHE_VERSION = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LOGGED_PROBLEMS = 10;
// Older than this, the UI warns that the cached data may be out of date.
// A warning only: printing never stops just because the cache is old.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// rows: [{ row, order, qty }] exactly as the sheet had them (strings).
// Returns { orders: { [order]: qty }, invalid: { [order]: reason }, problems: [...] }.
//
// Duplicate order rows are handled deterministically, never "whichever came
// first": rows that agree collapse into one; rows that disagree (or where any
// copy is invalid) make that order unprintable until the sheet is fixed -
// printing the wrong number of labels is worse than printing none.
function normalizeSourceRows(rows) {
  const byOrder = new Map(); // order -> [{ row, result }]
  const problems = [];

  for (const entry of Array.isArray(rows) ? rows : []) {
    const item = entry && typeof entry === 'object' ? entry : {};
    const rawOrder = String(item.order == null ? '' : item.order).trim();
    const rawQty = item.qty;
    if (!rawOrder && String(rawQty == null ? '' : rawQty).trim() === '') continue; // blank row
    const rowNumber = Number.isInteger(item.row) ? item.row : null;
    const order = normalizeOrderNumber(rawOrder);
    if (!order) {
      problems.push({ row: rowNumber, order: rawOrder.slice(0, 30), reason: 'Order number is not in the 1234 or 1234-2 format' });
      continue;
    }
    if (!byOrder.has(order)) byOrder.set(order, []);
    byOrder.get(order).push({ row: rowNumber, result: parseQuantity(rawQty) });
  }

  const orders = {};
  const invalid = {};
  for (const [order, entries] of byOrder) {
    const bad = entries.find((e) => !e.result.ok);
    if (bad) {
      const reason = entries.length > 1 ? `${bad.result.reason} (row ${bad.row}; order appears ${entries.length} times)` : bad.result.reason;
      invalid[order] = reason;
      problems.push({ row: bad.row, order, reason });
      continue;
    }
    const quantities = new Set(entries.map((e) => e.result.qty));
    if (quantities.size > 1) {
      const reason = `Order appears ${entries.length} times with different quantities (${[...quantities].join(', ')})`;
      invalid[order] = reason;
      problems.push({ row: entries[0].row, order, reason });
      continue;
    }
    orders[order] = entries[0].result.qty;
  }
  return { orders, invalid, problems };
}

// Never throws: a missing, damaged or wrong-version file reads as "no cache".
function loadCache(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== CACHE_VERSION || !parsed.orders || typeof parsed.orders !== 'object') return null;
    // Re-checked on load: a hand-edited cache can never smuggle in a bad quantity.
    const orders = {};
    for (const [order, qty] of Object.entries(parsed.orders)) {
      const checked = parseQuantity(qty);
      if (normalizeOrderNumber(order) === order && checked.ok) orders[order] = checked.qty;
    }
    const invalid = {};
    for (const [order, reason] of Object.entries(parsed.invalid || {})) {
      if (normalizeOrderNumber(order) === order) invalid[order] = String(reason).slice(0, 200);
    }
    return {
      version: CACHE_VERSION,
      refreshedAt: typeof parsed.refreshedAt === 'string' ? parsed.refreshedAt : null,
      sheetName: typeof parsed.sheetName === 'string' ? parsed.sheetName : '',
      orders,
      invalid
    };
  } catch {
    return null;
  }
}

function saveCache(filePath, cache) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache), 'utf8');
  fs.renameSync(temp, filePath);
}

// deps:
//   cachePath            - temp-labels-cache.json
//   fetchRows()          -> Promise<{ ok: true, rows, sheetName } | { ok: false, error }>
//   logger { info, warn, error }
//   now()                -> Date (tests)
//   onStatus(status)     - UI notification after every refresh (optional)
function createTempLabelSource({ cachePath, fetchRows, logger, now = () => new Date(), onStatus = () => {} }) {
  let cache = loadCache(cachePath);
  let refreshing = null; // the in-flight refresh promise, shared by overlapping callers
  let timer = null;
  const state = { lastAttemptAt: null, lastError: null, lastErrorAt: null, lastRefreshOk: null };

  if (cache) {
    logger.info(`Temporary-label source: loaded cached data from ${cache.refreshedAt || 'an unknown time'} (${Object.keys(cache.orders).length} orders).`);
  }

  function status() {
    const ordersCached = cache ? Object.keys(cache.orders).length : 0;
    let sourceState;
    if (state.lastRefreshOk === true) sourceState = 'connected';
    else if (cache) sourceState = 'cached'; // never refreshed this run, or the last refresh failed
    else if (state.lastRefreshOk === false) sourceState = 'error';
    else sourceState = 'empty';
    const refreshedMs = cache && cache.refreshedAt ? Date.parse(cache.refreshedAt) : NaN;
    // A cache with no readable refresh time counts as old, too.
    const stale = Boolean(cache) && (!Number.isFinite(refreshedMs) || now().getTime() - refreshedMs > STALE_AFTER_MS);
    return {
      state: sourceState,
      stale,
      refreshing: Boolean(refreshing),
      lastSuccessAt: cache ? cache.refreshedAt : null,
      ordersCached,
      invalidOrders: cache ? Object.keys(cache.invalid).length : 0,
      sheetName: cache ? cache.sheetName : '',
      lastAttemptAt: state.lastAttemptAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt
    };
  }

  function notify() {
    try {
      onStatus(status());
    } catch {
      // UI notification only
    }
  }

  async function doRefresh(reason) {
    state.lastAttemptAt = now().toISOString();
    let result;
    try {
      result = await fetchRows();
    } catch (err) {
      result = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!result || !result.ok || !Array.isArray(result.rows)) {
      const error = (result && result.error) || 'The website returned no rows.';
      state.lastRefreshOk = false;
      state.lastError = String(error).slice(0, 300);
      state.lastErrorAt = state.lastAttemptAt;
      if (cache) {
        logger.warn(`Temporary-label source refresh failed (${reason}): ${state.lastError} - still using cached data from ${cache.refreshedAt} (${Object.keys(cache.orders).length} orders).`);
      } else {
        logger.warn(`Temporary-label source refresh failed (${reason}): ${state.lastError} - there is no cached data, so temporary labels cannot print yet.`);
      }
      return status();
    }

    const normalized = normalizeSourceRows(result.rows);
    const next = {
      version: CACHE_VERSION,
      refreshedAt: state.lastAttemptAt,
      sheetName: typeof result.sheetName === 'string' ? result.sheetName.slice(0, 100) : '',
      orders: normalized.orders,
      invalid: normalized.invalid
    };
    try {
      saveCache(cachePath, next);
    } catch (err) {
      // Still use the fresh data this run; the previous file stays on disk.
      logger.warn(`Temporary-label source: could not save the local cache (${err.message}); using the new data in memory only.`);
    }
    cache = next;
    state.lastRefreshOk = true;
    state.lastError = null;
    const count = Object.keys(next.orders).length;
    logger.info(`Temporary-label source refreshed (${reason}): ${count} orders cached${normalized.problems.length ? `, ${normalized.problems.length} row(s) rejected` : ''}.`);
    for (const p of normalized.problems.slice(0, MAX_LOGGED_PROBLEMS)) {
      logger.warn(`Temporary-label source row rejected - Row: ${p.row == null ? '?' : p.row}, Order: ${p.order || '(blank)'}, Reason: ${p.reason}`);
    }
    if (normalized.problems.length > MAX_LOGGED_PROBLEMS) {
      logger.warn(`Temporary-label source: ${normalized.problems.length - MAX_LOGGED_PROBLEMS} more rejected row(s) not listed.`);
    }
    return status();
  }

  // Single-flight: a manual refresh during a timed one waits for that one.
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

  // { ok: true, qty } or { ok: false, reason } - in-memory, never the network.
  function lookup(order) {
    if (!cache) return { ok: false, reason: 'No temporary-label data has been downloaded yet (check the website/Google Sheet connection)' };
    if (Object.prototype.hasOwnProperty.call(cache.orders, order)) return { ok: true, qty: cache.orders[order] };
    if (Object.prototype.hasOwnProperty.call(cache.invalid, order)) return { ok: false, reason: `Invalid temporary-label row: ${cache.invalid[order]}` };
    return { ok: false, reason: 'Order not found in temporary-label source' };
  }

  function start(intervalMs = DEFAULT_REFRESH_INTERVAL_MS) {
    stop();
    refresh('start-up').catch(() => {});
    timer = setInterval(() => refresh('scheduled').catch(() => {}), intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, lookup, status, start, stop };
}

module.exports = {
  CACHE_VERSION,
  DEFAULT_REFRESH_INTERVAL_MS,
  STALE_AFTER_MS,
  normalizeSourceRows,
  loadCache,
  saveCache,
  createTempLabelSource
};
