// General Door Code Printing settings: which stations print an order's labels
// when they scan its general door code, and on which printer.
//
// Stored as door-print-settings.json in Electron's userData folder
// (%APPDATA%\Door Tracker COM Bridge\ on Windows) - beside settings.json and
// printer-settings.json, never in the installation folder, so installing an
// update keeps it. A separate file on purpose: it cannot disturb the COM
// connection settings Remote Admin edits (com-settings.js), and Remote Admin
// has no route to this file at all.
//
// Keyed by STATION, never by COM port: a scanner moved to another port but
// left on the same station keeps its printing rule.
//
// There is no "use the default printer" anywhere here - an enabled station
// always names its printer, and printer-service.js prints to exactly that
// printer or fails.
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const { isStationKey, STATIONS } = require('./com-options');

const stationName = (key) => (STATIONS.find((s) => s.key === key) || { label: key }).label;

const MAX_PRINTER_NAME_LENGTH = 220;

function emptySettings() {
  return { stations: [] };
}

function cleanPrinterName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Returns { ok: true, settings } or { ok: false, errors }. `installedPrinters`
// (an array of names), when given, is checked too: an ENABLED station must
// name a printer Windows currently has installed.
function validateDoorPrintSettings(input, { installedPrinters } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(raw.stations) ? raw.stations : [];
  const errors = [];
  const seen = new Set();
  const stations = [];

  for (const entry of list) {
    const row = entry && typeof entry === 'object' ? entry : {};
    const stationKey = String(row.stationKey == null ? '' : row.stationKey);
    if (!isStationKey(stationKey)) {
      errors.push(`"${stationKey.slice(0, 40)}" is not one of the listed stations.`);
      continue;
    }
    if (seen.has(stationKey)) {
      errors.push(`Station "${stationName(stationKey)}" is listed more than once.`);
      continue;
    }
    seen.add(stationKey);

    const enabled = row.enabled === true;
    const printerName = cleanPrinterName(row.printerName);
    if (printerName.length > MAX_PRINTER_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(printerName)) {
      errors.push(`The printer name for "${stationName(stationKey)}" is not valid.`);
      continue;
    }
    if (enabled && !printerName) {
      errors.push(`Choose a printer for "${stationName(stationKey)}" before enabling it.`);
      continue;
    }
    if (enabled && Array.isArray(installedPrinters) && !installedPrinters.includes(printerName)) {
      errors.push(`Printer "${printerName}" is not installed on this PC - choose one from the list.`);
      continue;
    }
    stations.push({ stationKey, enabled, printerName });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { stations } };
}

// Never throws: a missing or damaged file reads as "nothing enabled", so a
// bad file can only ever stop printing, never print somewhere unexpected.
function loadDoorPrintSettings(filePath) {
  try {
    const result = validateDoorPrintSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return result.ok ? result.settings : emptySettings();
  } catch {
    return emptySettings();
  }
}

// Validates, then writes to a temporary file and renames it into place.
function saveDoorPrintSettings(filePath, input, options = {}) {
  const result = validateDoorPrintSettings(input, options);
  if (!result.ok) return result;
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result.settings, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
  return result;
}

// The rule for one station, or null when it has none.
function ruleForStation(settings, stationKey) {
  const list = settings && Array.isArray(settings.stations) ? settings.stations : [];
  return list.find((row) => row.stationKey === stationKey) || null;
}

module.exports = { MAX_PRINTER_NAME_LENGTH, emptySettings, validateDoorPrintSettings, loadDoorPrintSettings, saveDoorPrintSettings, ruleForStation };
