// Temporary Data Matrix labels: which scans trigger them, how a quantity from
// the source sheet is checked, and how the temporary codes are generated.
//
// Pure functions only - no files, no printer, no network - so every rule here
// is tested directly (see temp-labels.test.js).
'use strict';

// A safety limit, not a business rule: a malformed sheet row (a part number,
// a year, a pasted total) must never be able to print hundreds or thousands
// of labels from one scan.
const MAX_TEMP_LABELS_PER_SCAN = 200;

// The order number exactly as the trigger extracts it: 4 digits, optionally a
// 1-3 digit call-off ("5698", "5626-2", "5626-12").
const ORDER_NUMBER_PATTERN = /^[0-9]{4}(?:-[0-9]{1,3})?$/;

// Test-print codes typed by an operator: capitals, digits and hyphens only,
// starting and ending with a letter/digit. Deliberately excludes ^ and ~,
// which are ZPL control characters.
const TEST_CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,38}[A-Z0-9])?$/;

// The trigger: an order's general door code and nothing else -
// <4 digits>[-<1-3 digit call-off>]-D, after trimming and upper-casing. No
// unit suffix ("-D-01"), no frame ("-F"), no delivery ("-DELIV"), no
// temporary code ("-T-01"). The call-off follows the same "digit group after
// a hyphen" convention as delivery-photos/reference.js. Capture group 1 is
// the order number.
const GENERAL_DOOR_CODE_PATTERN = /^([0-9]{4}(?:-[0-9]{1,3})?)-D$/;
const MAX_TRIGGER_LENGTH = 20;

// Returns { order } (e.g. { order: '5626-2' }) or null.
function parseTempLabelTrigger(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  if (!value || value.length > MAX_TRIGGER_LENGTH) return null;
  const match = GENERAL_DOOR_CODE_PATTERN.exec(value);
  return match ? { order: match[1] } : null;
}

function normalizeOrderNumber(raw) {
  const value = String(raw == null ? '' : raw).trim().toUpperCase();
  return ORDER_NUMBER_PATTERN.test(value) ? value : null;
}

// Returns { ok: true, qty } or { ok: false, reason }. Accepts a whole number
// as a number or as text ("4", " 4 ", "04", and "4.0"/"4.00" in case the
// column is formatted with decimals); rejects blank, text, fractions, zero,
// negatives and anything above MAX_TEMP_LABELS_PER_SCAN.
function parseQuantity(raw, { max = MAX_TEMP_LABELS_PER_SCAN } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, reason: 'Quantity is blank' };
  if (/^-\s*\d/.test(text)) return { ok: false, reason: `Quantity "${text.slice(0, 20)}" is negative` };
  if (!/^\d+(?:\.0+)?$/.test(text)) return { ok: false, reason: `Quantity "${text.slice(0, 20)}" is not a whole number` };
  const qty = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(qty)) return { ok: false, reason: `Quantity "${text.slice(0, 20)}" is not a whole number` };
  if (qty === 0) return { ok: false, reason: 'Quantity is zero' };
  if (qty > max) return { ok: false, reason: `Quantity ${qty} is above the safety limit of ${max} labels per scan` };
  return { ok: true, qty };
}

// 1 -> "01", 9 -> "09", 99 -> "99", 100 -> "100": two digits for normal
// values, wider only when needed, so codes are always unique and never
// truncated.
function sequenceSuffix(n) {
  return n < 100 ? String(n).padStart(2, '0') : String(n);
}

// "5698" + 3 -> ["5698-T-01", "5698-T-02", "5698-T-03"]. Throws on an
// invalid order number or quantity - callers validate first; this is the
// last line of defence before anything reaches a printer.
function generateTempCodes(order, qty) {
  const normalized = normalizeOrderNumber(order);
  if (!normalized) throw new Error(`"${String(order).slice(0, 20)}" is not a valid order number.`);
  const checked = parseQuantity(qty);
  if (!checked.ok) throw new Error(checked.reason);
  const codes = [];
  for (let n = 1; n <= checked.qty; n += 1) codes.push(`${normalized}-T-${sequenceSuffix(n)}`);
  return codes;
}

// "5698-T-01 through 5698-T-12" (or just the one code) for log lines.
function describeCodeRange(codes) {
  if (!codes || codes.length === 0) return '(none)';
  if (codes.length === 1) return codes[0];
  return `${codes[0]} through ${codes[codes.length - 1]}`;
}

function normalizeTestCode(raw) {
  const value = String(raw == null ? '' : raw).trim().toUpperCase();
  return TEST_CODE_PATTERN.test(value) ? value : null;
}

module.exports = {
  GENERAL_DOOR_CODE_PATTERN,
  MAX_TEMP_LABELS_PER_SCAN,
  ORDER_NUMBER_PATTERN,
  TEST_CODE_PATTERN,
  parseTempLabelTrigger,
  normalizeOrderNumber,
  parseQuantity,
  sequenceSuffix,
  generateTempCodes,
  describeCodeRange,
  normalizeTestCode
};
