// Start-up cleanup of the retired General Door Code Printing settings file,
// and why print-attempts.json is deliberately NOT pruned.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { RETIRED_FILES, removeRetiredFiles } = require('./retired-files');
const { createPrintAttemptStore } = require('./print-attempt-store');

const SRC = __dirname;

function userDataDir() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'combridge-retired-'));
}

function memoryLogger() {
  const lines = [];
  return { lines, info: (m) => lines.push(['INFO', m]), warn: (m) => lines.push(['WARN', m]), error: (m) => lines.push(['ERROR', m]) };
}

test('the retired door-print-settings.json is removed, logged, and nothing else is touched', () => {
  const dir = userDataDir();
  const keep = {
    'temp-label-settings.json': '{"stations":[]}',
    'temp-labels-cache.json': '{}',
    'temp-labels-access-key.json': '{}',
    'settings.json': '{}',
    'printer-settings.json': '{}',
    'print-attempts.json': '{"PJ-1":{"state":"SUBMITTED","recordedAt":"2026-11-01T00:00:00.000Z"}}',
    'door-print-settings.json.bak': 'not the exact name'
  };
  for (const [name, body] of Object.entries(keep)) fs.writeFileSync(nodePath.join(dir, name), body);
  fs.writeFileSync(nodePath.join(dir, 'door-print-settings.json'), '{"stations":[{"stationKey":"joint_prehung","enabled":true,"printerName":"TSC TE200"}]}');

  const logger = memoryLogger();
  assert.deepEqual(removeRetiredFiles({ dir, logger }), ['door-print-settings.json']);
  assert.equal(fs.existsSync(nodePath.join(dir, 'door-print-settings.json')), false);
  for (const [name, body] of Object.entries(keep)) assert.equal(fs.readFileSync(nodePath.join(dir, name), 'utf8'), body, name);
  assert.ok(fs.statSync(dir).isDirectory(), 'the user-data folder stays');
  assert.deepEqual(logger.lines, [['INFO', 'Removed obsolete settings file door-print-settings.json (retired General Door Code Printing).']]);
});

test('a missing file is harmless and silent, and the cleanup is idempotent', () => {
  const dir = userDataDir();
  fs.writeFileSync(nodePath.join(dir, 'door-print-settings.json'), '{}');
  const logger = memoryLogger();
  assert.deepEqual(removeRetiredFiles({ dir, logger }), ['door-print-settings.json']);
  assert.deepEqual(removeRetiredFiles({ dir, logger }), [], 'second run does nothing');
  assert.deepEqual(removeRetiredFiles({ dir: nodePath.join(dir, 'does-not-exist'), logger }), [], 'even a missing folder is fine');
  assert.equal(logger.lines.length, 1, 'only the one real removal is logged');
});

test('failures never throw: a directory with that name, a permission error, a broken logger', (t) => {
  const dir = userDataDir();
  fs.mkdirSync(nodePath.join(dir, 'door-print-settings.json'));
  fs.writeFileSync(nodePath.join(dir, 'door-print-settings.json', 'inside.txt'), 'x');
  const logger = memoryLogger();
  assert.deepEqual(removeRetiredFiles({ dir, logger }), []);
  assert.ok(fs.existsSync(nodePath.join(dir, 'door-print-settings.json', 'inside.txt')), 'a directory is never deleted');
  assert.equal(logger.lines[0][0], 'WARN');

  const other = userDataDir();
  fs.writeFileSync(nodePath.join(other, 'door-print-settings.json'), '{}');
  t.mock.method(fs, 'unlinkSync', () => { const err = new Error('denied'); err.code = 'EPERM'; throw err; });
  const warned = memoryLogger();
  assert.deepEqual(removeRetiredFiles({ dir: other, logger: warned }), []);
  assert.match(warned.lines[0][1], /Could not remove obsolete settings file door-print-settings\.json: EPERM/);
  t.mock.restoreAll();

  const broken = { info: () => { throw new Error('log full'); }, warn: () => { throw new Error('log full'); } };
  assert.deepEqual(removeRetiredFiles({ dir: other, logger: broken }), ['door-print-settings.json'], 'removed even if logging fails');
});

test('only exact plain file names are ever removed - never a path outside the folder', () => {
  const parent = userDataDir();
  const dir = nodePath.join(parent, 'userData');
  fs.mkdirSync(dir);
  fs.writeFileSync(nodePath.join(parent, 'outside.json'), '{}');
  assert.deepEqual(removeRetiredFiles({ dir, logger: memoryLogger(), names: ['../outside.json', '..', '.', '', null] }), []);
  assert.ok(fs.existsSync(nodePath.join(parent, 'outside.json')));
  assert.deepEqual([...RETIRED_FILES], ['door-print-settings.json'], 'the list is exactly the retired file');
});

test('main.js runs the cleanup on start-up inside a guard, against the user-data folder', () => {
  const main = fs.readFileSync(nodePath.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\n[^]*?try \{\n\s+removeRetiredFiles\(\{ dir: app\.getPath\('userData'\), logger: comLogger \}\);\n\s+\} catch \{/);
});

test('no production code references door-print-settings.json except the cleanup itself', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(entry.name) && !entry.name.endsWith('.test.js')) files.push(full);
    }
  })(SRC);
  const referencing = files.filter((f) => fs.readFileSync(f, 'utf8').includes('door-print-settings')).map((f) => nodePath.relative(SRC, f));
  assert.deepEqual(referencing, ['retired-files.js']);
});

// print-attempts.json records are { [jobId]: { state, recordedAt } } - the job
// id the WEBSITE assigned and nothing else. Jobs from the retired feature were
// ordinary website print jobs (the same PJ-... ids, the same PRINT_JOBS rows
// as delivery labels); the "general-door:<station>" marker lived only in the
// website's station_key column, never in this file. So a leftover record
// cannot be told apart from a live delivery/TE200 record, and pruning would
// risk removing the duplicate-print safety net of a real job. The file is
// therefore left exactly as it is.
test('print-attempts.json is never pruned: its records carry no feature information to tell them apart', () => {
  const dir = userDataDir();
  const file = nodePath.join(dir, 'print-attempts.json');
  const store = createPrintAttemptStore(file);
  store.setAttempting('PJ-delivery');
  store.setSubmitted('PJ-from-retired-feature');
  const before = fs.readFileSync(file, 'utf8');
  for (const record of Object.values(JSON.parse(before))) assert.deepEqual(Object.keys(record).sort(), ['recordedAt', 'state']);

  fs.writeFileSync(nodePath.join(dir, 'door-print-settings.json'), '{}');
  removeRetiredFiles({ dir, logger: memoryLogger() });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'start-up cleanup leaves print-attempts.json untouched');
  assert.equal(store.get('PJ-delivery').state, 'ATTEMPTING');
  assert.equal(store.get('PJ-from-retired-feature').state, 'SUBMITTED');
});
