// The Windows app's start-up, run as independent SECTIONS (station lists,
// settings and tabs, COM ports, printer discovery, printer status, the
// Temporary Data Matrix settings / source status / access key, ...).
//
// Before this, renderer.js's init() awaited each part in turn with no error
// handling, so ONE failure - Windows printer discovery timing out, say -
// rejected init() and every later part (the Temporary Data Matrix station
// dropdown, layout fields, source status, key status) was simply never
// filled in. Each section now runs through runSection(), which never
// rejects: a failure is logged and recorded, and the other sections carry on.
//
// Works unchanged as a plain <script> in the window (window.InitSections)
// and with require() in the Node tests - the same pattern as com-options.js.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InitSections = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const messageOf = (err) => (err && err.message ? err.message : String(err));

  // Runs one section. Resolves (never rejects) with
  //   { name, ok: true,  ms, detail }   - detail: what fn() returned, e.g. "27 stations"
  //   { name, ok: false, ms, error }    - error: the failure's message
  // A failure is reported straight away through log('warn', ...).
  async function runSection(name, fn, { log = () => {}, now = () => Date.now() } = {}) {
    const started = now();
    try {
      const detail = await fn();
      return { name, ok: true, ms: now() - started, detail: detail == null ? '' : String(detail) };
    } catch (err) {
      const error = messageOf(err);
      try {
        log('warn', `${name} failed: ${error}`);
      } catch {
        // Reporting a failure must never become a second failure.
      }
      return { name, ok: false, ms: now() - started, error };
    }
  }

  // One line for the log once every section has finished:
  //   { level: 'info' | 'warn', message }
  function summarizeInit(results, totalMs) {
    const failed = results.filter((r) => !r.ok);
    const parts = results.map((r) => (r.ok ? `${r.name}: ${r.detail || 'ok'}` : `${r.name}: FAILED (${r.error})`));
    const tail = failed.length ? ` - ${failed.length} of ${results.length} section(s) failed` : ` - all ${results.length} sections loaded`;
    return {
      level: failed.length ? 'warn' : 'info',
      message: `Window initialisation completed in ${totalMs}ms${tail}. ${parts.join('; ')}.`
    };
  }

  return { runSection, summarizeInit };
});
