// Comparing a configured printer name with the names Windows reports.
//
// Windows printer (queue) names are compared EXACTLY. The only things
// removed first are output artefacts at the very start or end of a name -
// spaces, CR/LF, tabs, NUL and other control characters, a byte-order mark,
// zero-width spaces - which are never part of a real queue name (the saved
// settings already trim them). Nothing inside a name is changed: "(203 dpi)"
// and "(203 dpi) (Copy 1)", or "TSC TE210" and "TSC TE210 #2", or a local
// queue and a "\\server\share" connection to a printer of the same name, are
// different printers and never match each other.
//
// The one other match accepted is a difference in letter case only, because
// the Windows spooler itself treats queue names case-insensitively - two
// queues cannot differ only by case, and OpenPrinter opens the same queue
// either way. It is reported as such in the log.
'use strict';

const EDGE_ARTEFACTS = /^[\s\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]+|[\s\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]+$/g;

function normalizePrinterName(name) {
  return typeof name === 'string' ? name.replace(EDGE_ARTEFACTS, '') : '';
}

const upper = (s) => s.toUpperCase();

// The share part of "\\server\share" (a printer connection), else null.
function connectionShare(name) {
  const m = /^\\\\[^\\]+\\(.+)$/.exec(name);
  return m ? m[1] : null;
}

// Returns { found, how: 'exact'|'case'|null, name (the Windows name matched),
// requested (normalized), cleaned (true when artefacts were removed),
// similar: [names that are NOT a match but look alike - for the log only] }.
function matchPrinterName(requested, installedNames) {
  const rawRequested = typeof requested === 'string' ? requested : '';
  const wanted = normalizePrinterName(rawRequested);
  const list = (Array.isArray(installedNames) ? installedNames : [])
    .filter((n) => typeof n === 'string')
    .map((raw) => ({ raw, name: normalizePrinterName(raw) }));
  const result = (found, how, entry, similar = []) => ({
    found,
    how,
    name: entry ? entry.raw : null,
    requested: wanted,
    cleaned: wanted !== rawRequested || Boolean(entry && entry.name !== entry.raw),
    similar
  });
  if (!wanted) return result(false, null, null);

  const exact = list.find((e) => e.name === wanted);
  if (exact) return result(true, 'exact', exact);
  const byCase = list.filter((e) => upper(e.name) === upper(wanted));
  if (byCase.length === 1) return result(true, 'case', byCase[0]);

  const w = upper(wanted);
  const similar = list
    .filter((e) => {
      const n = upper(e.name);
      const share = connectionShare(n);
      return (share && share === w) || n.includes(w) || (n.length >= 4 && w.includes(n));
    })
    .map((e) => e.raw)
    .slice(0, 5);
  return result(false, null, null, similar);
}

// A name in quotes with any invisible character shown as \uXXXX, so a log
// line shows exactly what was compared (a trailing space shows inside the
// quotes; a CR, BOM or zero-width space shows as its code).
function showPrinterName(name) {
  const text = String(name == null ? '' : name).replace(
    /[\u0000-\u001f\u007f-\u00a0\u00ad\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `"${text}"`;
}

const MAX_LOGGED_NAMES = 30;

// One log fragment: what was asked for, what Windows listed, and the result.
// `check` is checkPrinterForPrinting()'s result (requested, installedNames,
// namesOk, nameMatch, keyFound, foundBy). Printer names are not secret;
// "\\server\share" names are still shortened by the logger itself.
function describePrinterNameCheck(check) {
  if (!check || !check.nameMatch) return '';
  const m = check.nameMatch;
  const names = Array.isArray(check.installedNames) ? check.installedNames : [];
  const shown = names.slice(0, MAX_LOGGED_NAMES).map(showPrinterName).join(', ');
  const more = names.length > MAX_LOGGED_NAMES ? `, ... ${names.length - MAX_LOGGED_NAMES} more` : '';
  const parts = [`requested ${showPrinterName(check.requested)}`];
  parts.push(check.namesOk === false
    ? 'installed printers: InstalledPrinters could not be read'
    : `installed printers from InstalledPrinters (${names.length}): ${shown || 'none'}${more}`);
  let outcome;
  if (m.how === 'exact') outcome = `exact match${m.cleaned ? ' after removing spaces/control characters at the ends' : ''}`;
  else if (m.how === 'case') outcome = `matched ${showPrinterName(m.name)}, differing only in letter case (Windows treats these as the same printer)`;
  else outcome = `no printer with exactly this name${m.similar.length ? ` (similar names, NOT used: ${m.similar.map(showPrinterName).join(', ')})` : ''}`;
  parts.push(`result: ${outcome}`);
  if (!m.found) {
    const key = check.keyFound ? 'found' : ({ timeout: 'did not answer in time', failed: 'failed' }[check.details] || 'not found');
    parts.push(`Win32_Printer lookup by this exact name: ${key}`);
  }
  return parts.join('; ');
}

module.exports = { normalizePrinterName, matchPrinterName, showPrinterName, describePrinterNameCheck };
