// Start-up cleanup of settings files left behind by features that no longer
// exist. Today that is only the retired General Door Code Printing feature's
// settings file; Temporary Data Matrix Printing replaced it and keeps its own
// settings in temp-label-settings.json, which is never touched here.
//
// Deliberately narrow:
//   - only the exact file names listed below, directly inside the user-data
//     folder - never a pattern, never the folder itself, never a directory
//     (unlinkSync refuses directories);
//   - a missing file is the normal case and is silent;
//   - any other failure is logged and ignored - this can never stop start-up.
// Safe to run on every start: once a file is gone there is nothing to do.
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

const RETIRED_FILES = Object.freeze([
  // General Door Code Printing (station -> printer rules), retired in favour
  // of Temporary Data Matrix Printing. Never read by any current code.
  'door-print-settings.json'
]);

function safeLog(logger, level, message) {
  try {
    logger[level](message);
  } catch {
    // logging is best-effort
  }
}

// Returns the names actually removed (for tests). Never throws.
function removeRetiredFiles({ dir, logger, names = RETIRED_FILES }) {
  const removed = [];
  for (const name of names) {
    // A plain file name only - never a path that could leave `dir`.
    if (typeof name !== 'string' || name !== nodePath.basename(name) || name === '.' || name === '..') continue;
    const target = nodePath.join(dir, name);
    try {
      fs.unlinkSync(target);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      safeLog(logger, 'warn', `Could not remove obsolete settings file ${name}: ${(err && err.code) || (err && err.message) || err}`);
      continue;
    }
    removed.push(name);
    safeLog(logger, 'info', `Removed obsolete settings file ${name} (retired General Door Code Printing).`);
  }
  return removed;
}

module.exports = { RETIRED_FILES, removeRetiredFiles };
