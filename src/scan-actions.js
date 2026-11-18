// What happens to every scan from a COM connection: it is submitted to the
// website exactly as before, then each extra scan action (today only
// Temporary Data Matrix Printing - see temp-labels/trigger.js) gets its
// chance, in order.
//
// A trigger that throws is reported through onTriggerError and ignored - it
// can never undo or delay the production scan, or stop the triggers after
// it. Triggers decide synchronously and do any printing in the background, so
// nothing here ever waits on a printer or holds up the serial read loop.
'use strict';

function runScanActions({ postScan, triggers = [], scan, onTriggerError }) {
  const posted = postScan();
  for (const each of triggers) {
    try {
      each.handleScan(scan);
    } catch (err) {
      if (typeof onTriggerError === 'function') onTriggerError(err);
    }
  }
  return posted;
}

module.exports = { runScanActions };
