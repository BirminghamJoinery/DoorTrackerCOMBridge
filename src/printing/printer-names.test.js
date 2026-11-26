// Printer-name comparison (printer-names.js): exactly the Windows queue name,
// after removing only output artefacts at the ends of a name - never a
// similar-looking printer.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePrinterName, matchPrinterName, showPrinterName, describePrinterNameCheck } = require('./printer-names');

const TOSHIBA = 'TOSHIBA B-FV4 (203 dpi)';
const UNC_TOSHIBA = '\\\\DESKTOP-5OHKE65.bjltd.local\\TOSHIBA B-FV4 (203 dpi)';

// What Windows listed on the upstairs test laptop (HP-CND3420T5P) once the
// USB queue was back, 2026-11-26 09:26:24 - from its COM Bridge log.
const LAPTOP_NOW = [TOSHIBA, 'ZDesigner GK420d', 'TSC TE210 #2', 'TSC TE210', 'SHARP MX-4060N (7800736500)', 'SHARP MX-3050N PCL6', 'OneNote (Desktop)', 'Microsoft Print to PDF', UNC_TOSHIBA];
// ...and at 09:18:15, when the USB queue had been removed from Windows.
const LAPTOP_0918 = ['ZDesigner GK420d', 'TSC TE210 #2', 'TSC TE210', 'SHARP MX-4060N (7800736500)', 'SHARP MX-3050N PCL6', 'OneNote (Desktop)', 'Microsoft Print to PDF', UNC_TOSHIBA];

test('"TOSHIBA B-FV4 (203 dpi)" is found in the list Windows returns', () => {
  const m = matchPrinterName(TOSHIBA, LAPTOP_NOW);
  assert.equal(m.found, true);
  assert.equal(m.how, 'exact');
  assert.equal(m.name, TOSHIBA);
  assert.equal(m.cleaned, false);
});

test('harmless output artefacts at the ends are removed on either side, then the match is exact', () => {
  for (const listed of [
    `${TOSHIBA}\r\n`, `${TOSHIBA}\n`, `${TOSHIBA}\r`, ` ${TOSHIBA} `, `\t${TOSHIBA}`,
    `﻿${TOSHIBA}`, `${TOSHIBA}\u0000`, `${TOSHIBA}​`, ` ${TOSHIBA}`
  ]) {
    const m = matchPrinterName(TOSHIBA, ['TSC TE210', listed]);
    assert.equal(m.found, true, JSON.stringify(listed));
    assert.equal(m.how, 'exact');
    assert.equal(m.name, listed, 'reports the name exactly as Windows listed it');
    assert.equal(m.cleaned, true);
    assert.equal(matchPrinterName(listed, [TOSHIBA]).found, true, `requested ${JSON.stringify(listed)}`);
  }
  assert.equal(normalizePrinterName(`﻿  ${TOSHIBA} \r\n`), TOSHIBA);
  assert.equal(normalizePrinterName(42), '');
});

test('a letter-case difference only is the same Windows queue, and is reported as such', () => {
  const m = matchPrinterName('toshiba b-fv4 (203 DPI)', LAPTOP_NOW);
  assert.equal(m.found, true);
  assert.equal(m.how, 'case');
  assert.equal(m.name, TOSHIBA);
});

test('similar printers never match - copies, other dpi, other models, a network connection of the same name', () => {
  for (const other of [
    'TOSHIBA B-FV4 (203 dpi) (Copy 1)', 'TOSHIBA B-FV4 (300 dpi)', 'TOSHIBA B-FV4', 'TOSHIBA B-FV4D',
    'TOSHIBA B-FV4 (203dpi)', 'TOSHIBA  B-FV4 (203 dpi)', 'TOSHIBA B-FV4 [203 dpi]', UNC_TOSHIBA, '\\\\other\\TOSHIBA B-FV4 (203 dpi)'
  ]) {
    assert.equal(matchPrinterName(TOSHIBA, [other]).found, false, other);
    assert.equal(matchPrinterName(other, [TOSHIBA]).found, false, `requested ${other}`);
  }
  assert.equal(matchPrinterName('TSC TE210', ['TSC TE210 #2']).found, false);
  assert.equal(matchPrinterName('', [TOSHIBA]).found, false);
  assert.equal(matchPrinterName(TOSHIBA, []).found, false);
  assert.equal(matchPrinterName(TOSHIBA, null).found, false);
});

test('the 09:18 list (USB queue removed, only the network connection left) is "not found", with the look-alike named', () => {
  const m = matchPrinterName(TOSHIBA, LAPTOP_0918);
  assert.equal(m.found, false);
  assert.deepEqual(m.similar, [UNC_TOSHIBA]);
});

test('log text shows invisible characters and both sides of the comparison', () => {
  assert.equal(showPrinterName(`${TOSHIBA}\r\n`), `"${TOSHIBA}\\u000d\\u000a"`);
  assert.equal(showPrinterName(`﻿${TOSHIBA} `), `"\\ufeff${TOSHIBA} "`);
  assert.equal(showPrinterName(UNC_TOSHIBA), `"${UNC_TOSHIBA}"`);

  const found = describePrinterNameCheck({ requested: TOSHIBA, installedNames: LAPTOP_NOW, namesOk: true, nameMatch: matchPrinterName(TOSHIBA, LAPTOP_NOW) });
  assert.match(found, /^requested "TOSHIBA B-FV4 \(203 dpi\)"; installed printers from InstalledPrinters \(9\): "TOSHIBA B-FV4 \(203 dpi\)", "ZDesigner GK420d", .*; result: exact match$/);

  const missing = describePrinterNameCheck({ requested: TOSHIBA, installedNames: LAPTOP_0918, namesOk: true, details: 'not-found', keyFound: false, nameMatch: matchPrinterName(TOSHIBA, LAPTOP_0918) });
  assert.match(missing, /installed printers from InstalledPrinters \(8\): "ZDesigner GK420d"/);
  assert.match(missing, /result: no printer with exactly this name \(similar names, NOT used: "\\\\DESKTOP-5OHKE65\.bjltd\.local\\TOSHIBA B-FV4 \(203 dpi\)"\); Win32_Printer lookup by this exact name: not found$/);

  const unreadable = describePrinterNameCheck({ requested: TOSHIBA, installedNames: [], namesOk: false, details: 'timeout', nameMatch: matchPrinterName(TOSHIBA, []) });
  assert.match(unreadable, /installed printers: InstalledPrinters could not be read; result: no printer with exactly this name; Win32_Printer lookup by this exact name: did not answer in time$/);

  assert.equal(describePrinterNameCheck({ found: true }), '', 'an older result shape logs nothing extra');
  assert.equal(describePrinterNameCheck(null), '');
});

test('a long printer list is capped in the log', () => {
  const many = Array.from({ length: 45 }, (_, i) => `Printer ${i}`);
  const text = describePrinterNameCheck({ requested: 'Printer 44', installedNames: many, namesOk: true, nameMatch: matchPrinterName('Printer 44', many) });
  assert.match(text, /\(45\): .*"Printer 29", \.\.\. 15 more; result: exact match$/);
});
