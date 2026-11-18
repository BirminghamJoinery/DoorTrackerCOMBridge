// Temporary Data Matrix Printing settings: which stations print temporary
// labels when they scan a general door code, on which printer, and the label
// layout (size, Data Matrix module size, printer calibration offsets).
//
// Stored as temp-label-settings.json in Electron's userData folder
// (%APPDATA%\Door Tracker COM Bridge\ on Windows), beside settings.json -
// never in the installation folder, so an update keeps it. Its own file so it
// cannot disturb the main printer or the COM settings Remote Admin edits;
// Remote Admin has no route to it.
//
// Station rows are keyed by STATION, never by COM port: known stations only,
// no duplicates, an enabled station must name a printer, and (when the
// installed list is known) one Windows actually has. There is no "use the
// default printer" anywhere.
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const { isStationKey, STATIONS } = require('../com-options');
const { LABEL_SHIFT_X_MM, LABEL_SHIFT_Y_MM } = require('../printing/zpl-image');

// Starting point only - adjust in the app after the first physical test.
// Size and offsets are the ones the GK420D is already set up and calibrated
// for in this app (the 89x36mm test pattern / delivery label and the measured
// LABEL_SHIFT correction in printing/zpl-image.js). Nothing here assumes the
// TE200's settings.
const DEFAULT_LAYOUT = Object.freeze({
  widthMm: 89,
  heightMm: 36,
  dpi: 203,
  moduleDots: 8, // 1mm modules at 203dpi
  shiftXMm: LABEL_SHIFT_X_MM,
  shiftYMm: LABEL_SHIFT_Y_MM
});

const LAYOUT_LIMITS = {
  widthMm: [10, 120],
  heightMm: [5, 300],
  moduleDots: [3, 20],
  shiftXMm: [-10, 10],
  shiftYMm: [-10, 10]
};
const SUPPORTED_DPI = [203, 300];

const LAYOUT_LABELS = {
  widthMm: 'Label width (mm)',
  heightMm: 'Label height (mm)',
  moduleDots: 'Module size (dots)',
  shiftXMm: 'Horizontal offset (mm)',
  shiftYMm: 'Vertical offset (mm)'
};

const MAX_PRINTER_NAME_LENGTH = 220;
const stationName = (key) => (STATIONS.find((s) => s.key === key) || { label: key }).label;

// Returns { ok: true, stations } or { ok: false, errors }.
function validateStations(list, { installedPrinters } = {}) {
  const errors = [];
  const seen = new Set();
  const stations = [];
  for (const entry of Array.isArray(list) ? list : []) {
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
    const printerName = typeof row.printerName === 'string' ? row.printerName.trim() : '';
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
  return { ok: true, stations };
}

// The rule for one station, or null when it has none.
function ruleForStation(settings, stationKey) {
  const list = settings && Array.isArray(settings.stations) ? settings.stations : [];
  return list.find((row) => row.stationKey === stationKey) || null;
}

function defaultSettings() {
  return { stations: [], layout: { ...DEFAULT_LAYOUT } };
}

// Returns { ok: true, layout } or { ok: false, errors }.
function validateLayout(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = [];
  const layout = {};
  for (const [field, [min, max]] of Object.entries(LAYOUT_LIMITS)) {
    const value = typeof raw[field] === 'string' && raw[field].trim() !== '' ? Number(raw[field]) : raw[field];
    const wholeOnly = field === 'moduleDots';
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (wholeOnly && !Number.isInteger(value))) {
      errors.push(`${LAYOUT_LABELS[field]} must be ${wholeOnly ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
      continue;
    }
    layout[field] = Math.round(value * 10) / 10; // 0.1mm is finer than one 203dpi dot
  }
  const dpi = Number(raw.dpi);
  if (!SUPPORTED_DPI.includes(dpi)) errors.push(`Printer resolution must be ${SUPPORTED_DPI.join(' or ')} dpi.`);
  else layout.dpi = dpi;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, layout };
}

function validateTempLabelSettings(input, { installedPrinters } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const stations = validateStations(raw.stations, { installedPrinters });
  const layout = validateLayout(raw.layout);
  const errors = [...(stations.ok ? [] : stations.errors), ...(layout.ok ? [] : layout.errors)];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { stations: stations.stations, layout: layout.layout } };
}

// Never throws. Each half is read on its own: damaged station rows read as
// "nothing enabled" (a bad file can only ever stop printing, never print
// somewhere unexpected), a damaged layout reads as the default layout.
function loadTempLabelSettings(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultSettings();
  }
  const stations = validateStations(parsed && parsed.stations);
  const layout = validateLayout(parsed && parsed.layout);
  return {
    stations: stations.ok ? stations.stations : [],
    layout: layout.ok ? layout.layout : { ...DEFAULT_LAYOUT }
  };
}

// Validates, then writes to a temporary file and renames it into place.
function saveTempLabelSettings(filePath, input, options = {}) {
  const result = validateTempLabelSettings(input, options);
  if (!result.ok) return result;
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result.settings, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
  return result;
}

module.exports = {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  SUPPORTED_DPI,
  MAX_PRINTER_NAME_LENGTH,
  defaultSettings,
  validateStations,
  validateLayout,
  validateTempLabelSettings,
  loadTempLabelSettings,
  saveTempLabelSettings,
  ruleForStation
};
