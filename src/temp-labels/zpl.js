// The temporary label: ONE Data Matrix, centred horizontally and vertically,
// nothing else. Generated natively in ZPL with ^BX (the printer draws the
// symbol itself - no bitmap), so the module edges are exact printer dots.
//
// The symbol size is chosen HERE rather than left to the printer: knowing the
// exact number of modules is what makes exact centring possible. The smallest
// square ECC200 symbol whose capacity fits the code's ASCII encodation is
// used; any other encodation the printer might prefer is never larger, so a
// symbol of this size always holds the code.
//
// Pure - no printer, no files. See zpl-image.js for the existing label
// pipeline, which this does not touch.
'use strict';

const { mmToDots } = require('../printing/zpl-image');
const { TEST_CODE_PATTERN } = require('./codes');

// [symbol size in modules, data codewords] for square ECC200 symbols.
const ECC200_SQUARE_SIZES = [
  [10, 3], [12, 5], [14, 8], [16, 12], [18, 18], [20, 22], [22, 30],
  [24, 36], [26, 44], [32, 62], [36, 86], [40, 114], [44, 144]
];

// The Data Matrix standard needs at least 1 module of clear space; 2 is used
// so a label edge or a slightly mis-registered label never eats into it.
const MIN_QUIET_ZONE_MODULES = 2;
// Below 3 dots per module (0.375mm at 203dpi) direct-thermal print quality is
// not dependable enough for factory scanners.
const MIN_MODULE_DOTS = 3;

// ECC200 ASCII encodation: each pair of consecutive digits is one codeword,
// any other ASCII character is one codeword.
function asciiCodewordCount(text) {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const isDigit = (c) => c >= '0' && c <= '9';
    if (isDigit(text[i]) && i + 1 < text.length && isDigit(text[i + 1])) i += 2;
    else i += 1;
    count += 1;
  }
  return count;
}

function symbolModulesFor(text) {
  const needed = asciiCodewordCount(text);
  const size = ECC200_SQUARE_SIZES.find(([, capacity]) => capacity >= needed);
  if (!size) throw new Error(`"${text.slice(0, 20)}" is too long for a temporary label.`);
  return size[0];
}

// Works out where the symbol goes. Returns
// { widthDots, heightDots, modules, moduleDots, symbolDots, x, y, quietZoneDots }.
// The configured module size is a maximum: on a label too small for it, the
// module is reduced until the quiet zone fits, and refused below
// MIN_MODULE_DOTS rather than printing something scanners cannot read.
function layoutTempLabel(code, layout) {
  const widthDots = mmToDots(layout.widthMm, layout.dpi);
  const heightDots = mmToDots(layout.heightMm, layout.dpi);
  const modules = symbolModulesFor(code);
  const shortSide = Math.min(widthDots, heightDots);
  const fittingModuleDots = Math.floor(shortSide / (modules + 2 * MIN_QUIET_ZONE_MODULES));
  const moduleDots = Math.min(layout.moduleDots, fittingModuleDots);
  if (moduleDots < MIN_MODULE_DOTS) {
    throw new Error(`A ${layout.widthMm}x${layout.heightMm}mm label is too small for a readable Data Matrix of "${code}".`);
  }
  const symbolDots = modules * moduleDots;
  const x = Math.floor((widthDots - symbolDots) / 2);
  const y = Math.floor((heightDots - symbolDots) / 2);
  return { widthDots, heightDots, modules, moduleDots, symbolDots, x, y, quietZoneDots: Math.min(x, y) };
}

function assertPrintableCode(code) {
  // Same character rules as a typed test code; every generated code
  // ("5626-2-T-01") passes them too. Nothing else may reach ^FD.
  if (typeof code !== 'string' || !TEST_CODE_PATTERN.test(code)) {
    throw new Error(`"${String(code).slice(0, 40)}" cannot be printed as a temporary label.`);
  }
}

// One complete label ("^XA ... ^XZ") encoding exactly `code` - no prefix,
// suffix or metadata.
function buildTempLabelZpl(code, layout) {
  assertPrintableCode(code);
  const box = layoutTempLabel(code, layout);
  const shiftX = Math.round((layout.shiftXMm * layout.dpi) / 25.4);
  const shiftY = Math.round((layout.shiftYMm * layout.dpi) / 25.4);
  return [
    '^XA',
    '^MTD',
    `^PW${box.widthDots}`,
    `^LL${box.heightDots}`,
    '^LH0,0',
    `^LS${shiftX}`,
    `^LT${shiftY}`,
    `^FO${box.x},${box.y}^BXN,${box.moduleDots},200,${box.modules},${box.modules}^FD${code}^FS`,
    '^XZ',
    ''
  ].join('\n');
}

// A whole batch as ONE document: the printer processes each ^XA...^XZ in
// order, and it goes to Windows as one raw print job, so another job can
// never land in the middle of it.
function buildTempBatchZpl(codes, layout) {
  if (!Array.isArray(codes) || codes.length === 0) throw new Error('No temporary labels to print.');
  return codes.map((code) => buildTempLabelZpl(code, layout)).join('');
}

module.exports = {
  ECC200_SQUARE_SIZES,
  MIN_QUIET_ZONE_MODULES,
  MIN_MODULE_DOTS,
  asciiCodewordCount,
  symbolModulesFor,
  layoutTempLabel,
  buildTempLabelZpl,
  buildTempBatchZpl
};
