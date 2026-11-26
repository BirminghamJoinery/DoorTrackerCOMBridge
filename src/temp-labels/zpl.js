// The temporary label: ONE Data Matrix encoding exactly the generated code
// ("5698-T-01"), with that same full code printed as plain text above it.
// Text and symbol are centred horizontally, and centred vertically as one
// block. Generated natively in ZPL with ^BX (the printer draws the symbol
// itself - no bitmap), so the module edges are exact printer dots; the text
// is the printer's scalable font (^A0).
//
// The symbol size is chosen HERE rather than left to the printer: knowing the
// exact number of modules is what makes exact centring possible. The smallest
// square ECC200 symbol whose capacity fits the code's ASCII encodation is the
// starting point; any other encodation the printer might prefer is never
// larger, so a symbol of this size always holds the code.
//
// The symbol is then printed SYMBOL_GROWTH_MM (2mm) larger than that, by
// using a larger ECC200 size with the SAME module size: the default 1mm
// modules (8 dots at 203dpi) turn a 14x14 symbol (14.0mm) into a 16x16 one
// (16.0mm). A larger module size could not do this exactly - one more dot
// per module is +1.75mm on a 14-module symbol - and would have meant
// changing the module size already saved on each PC. The extra modules are
// only padding: the symbol still encodes exactly the same code.
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

// How much larger than its minimum size the symbol is printed (see above).
const SYMBOL_GROWTH_MM = 2;
// The code printed above the symbol: 4mm tall (32 dots at 203dpi) whenever
// it fits across the label, smaller only for a code too long for that
// (never below 2mm). The gap below it, and the margin above it, are the
// symbol's quiet zone (2 modules), so the text never enters the area a
// scanner needs clear; TEXT_SIDE_MARGIN_MM is kept clear at each side.
const LABEL_TEXT_HEIGHT_MM = 4;
const MIN_LABEL_TEXT_HEIGHT_MM = 2;
const TEXT_SIDE_MARGIN_MM = 2;
// Width of one character of ^A0 (the printer's scalable font, CG Triumvirate
// Bold Condensed) printed at height = width, as a fraction of that height -
// a deliberately generous bound (its digits, capitals and hyphen are
// narrower), so a line sized with it can never run past its ^FB block and
// wrap onto itself.
const TEXT_CHAR_WIDTH_RATIO = 0.85;

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

// The square ECC200 size SYMBOL_GROWTH_MM larger than `minModules` at
// `moduleDots`: the even number of extra modules closest to that growth
// (square sizes go up in 2s), at least 2. Null when there is none.
function grownModulesFor(minModules, moduleDots, dpi) {
  const growthDots = (SYMBOL_GROWTH_MM * dpi) / 25.4;
  const extra = Math.max(2, 2 * Math.round(growthDots / moduleDots / 2));
  const size = ECC200_SQUARE_SIZES.find(([modules]) => modules >= minModules + extra);
  return size ? size[0] : null;
}

// The text printed above the symbol: the full code, exactly as encoded
// ("5698-T-01", "5626-2-T-01", a typed test code).
function labelTextFor(code) {
  return String(code);
}

// Text height in dots: LABEL_TEXT_HEIGHT_MM, or less if `text` would not fit
// across the label inside its side margins. Null below MIN_LABEL_TEXT_HEIGHT_MM.
function labelTextDots(text, widthDots, dpi) {
  const available = widthDots - 2 * mmToDots(TEXT_SIDE_MARGIN_MM, dpi);
  const fitting = Math.floor(available / (text.length * TEXT_CHAR_WIDTH_RATIO));
  const dots = Math.min(mmToDots(LABEL_TEXT_HEIGHT_MM, dpi), fitting);
  return dots >= mmToDots(MIN_LABEL_TEXT_HEIGHT_MM, dpi) ? dots : null;
}

// Works out where the text and the symbol go. Returns
// { widthDots, heightDots, minModules, modules, grown, moduleDots, symbolDots,
//   x, y, quietZoneDots, text, textDots, textY }.
// The configured module size is a maximum, and larger modules come first: on
// a label too small for the grown symbol, the minimum-size symbol is tried at
// the same module size, and only then is the module reduced - refused below
// MIN_MODULE_DOTS rather than printing something scanners cannot read. Every
// candidate keeps MIN_QUIET_ZONE_MODULES of clear space on all four sides of
// the symbol, between it and the text too.
function layoutTempLabel(code, layout) {
  const widthDots = mmToDots(layout.widthMm, layout.dpi);
  const heightDots = mmToDots(layout.heightMm, layout.dpi);
  const minModules = symbolModulesFor(code);
  const text = labelTextFor(code);
  const textDots = labelTextDots(text, widthDots, layout.dpi);
  if (!textDots) {
    throw new Error(`A ${layout.widthMm}x${layout.heightMm}mm label is too small to print "${code}" readably above its Data Matrix.`);
  }

  for (let moduleDots = layout.moduleDots; moduleDots >= MIN_MODULE_DOTS; moduleDots -= 1) {
    const quiet = MIN_QUIET_ZONE_MODULES * moduleDots;
    for (const modules of [grownModulesFor(minModules, moduleDots, layout.dpi), minModules]) {
      if (!modules) continue;
      const symbolDots = modules * moduleDots;
      // [margin] text, gap, symbol [quiet zone] - or just the symbol.
      const blockDots = text ? textDots + quiet + symbolDots : symbolDots;
      if (symbolDots + 2 * quiet > widthDots || blockDots + 2 * quiet > heightDots) continue;
      const x = Math.floor((widthDots - symbolDots) / 2);
      const top = Math.floor((heightDots - blockDots) / 2);
      const y = text ? top + textDots + quiet : top;
      const below = heightDots - (y + symbolDots);
      return {
        widthDots,
        heightDots,
        minModules,
        modules,
        grown: modules !== minModules,
        moduleDots,
        symbolDots,
        x,
        y,
        quietZoneDots: Math.min(x, below, text ? quiet : y),
        text,
        textDots,
        textY: text ? top : null
      };
    }
  }
  throw new Error(`A ${layout.widthMm}x${layout.heightMm}mm label is too small for a readable Data Matrix of "${code}".`);
}

function assertPrintableCode(code) {
  // Same character rules as a typed test code; every generated code
  // ("5626-2-T-01") passes them too. Nothing else may reach ^FD.
  if (typeof code !== 'string' || !TEST_CODE_PATTERN.test(code)) {
    throw new Error(`"${String(code).slice(0, 40)}" cannot be printed as a temporary label.`);
  }
}

// One complete label ("^XA ... ^XZ"): the full code as text, centred across
// the label width (^FB ... C), then the Data Matrix encoding exactly the same
// `code` - no prefix, suffix or metadata in the symbol.
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
    ...(box.text ? [`^FO0,${box.textY}^A0N,${box.textDots},${box.textDots}^FB${box.widthDots},1,0,C,0^FD${box.text}^FS`] : []),
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
  SYMBOL_GROWTH_MM,
  LABEL_TEXT_HEIGHT_MM,
  MIN_LABEL_TEXT_HEIGHT_MM,
  TEXT_SIDE_MARGIN_MM,
  TEXT_CHAR_WIDTH_RATIO,
  labelTextDots,
  asciiCodewordCount,
  symbolModulesFor,
  grownModulesFor,
  labelTextFor,
  layoutTempLabel,
  buildTempLabelZpl,
  buildTempBatchZpl
};
