// init-sections.js: one start-up section failing never stops the others.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSection, summarizeInit } = require('./init-sections');

test('a successful section resolves ok with its detail', async () => {
  const result = await runSection('Temporary label station list', () => '27 stations');
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Temporary label station list');
  assert.equal(result.detail, '27 stations');
  assert.equal(typeof result.ms, 'number');
});

test('a failing section (sync throw or rejection) resolves - never rejects - and is logged once', async () => {
  const logged = [];
  const log = (level, message) => logged.push([level, message]);
  const thrown = await runSection('Printer list', () => { throw new Error('PowerShell did not finish within 30s and was stopped'); }, { log });
  const rejected = await runSection('Configured printer status', async () => { throw new Error('boom'); }, { log });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error, 'PowerShell did not finish within 30s and was stopped');
  assert.equal(rejected.ok, false);
  assert.deepEqual(logged, [
    ['warn', 'Printer list failed: PowerShell did not finish within 30s and was stopped'],
    ['warn', 'Configured printer status failed: boom']
  ]);
});

test('later sections still run after an earlier one fails', async () => {
  const ran = [];
  const results = [];
  results.push(await runSection('Printer list', async () => { ran.push('printers'); throw new Error('no printers'); }));
  results.push(await runSection('Temporary label station list', () => { ran.push('stations'); return '27 stations'; }));
  results.push(...await Promise.all([
    runSection('Temporary label settings', async () => { ran.push('settings'); return 'loaded'; }),
    runSection('Temporary label access key', async () => { ran.push('key'); throw new Error('unreadable'); }),
    runSection('Temporary label source status', async () => { ran.push('source'); return 'cached'; })
  ]));
  assert.deepEqual(ran, ['printers', 'stations', 'settings', 'key', 'source']);
  assert.deepEqual(results.map((r) => r.ok), [false, true, true, false, true]);
});

test('a logger that throws cannot turn one failure into two', async () => {
  const result = await runSection('X', () => { throw new Error('first'); }, { log: () => { throw new Error('logger broke'); } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'first');
});

test('non-Error rejections are still described', async () => {
  const result = await runSection('X', () => Promise.reject('plain string'));
  assert.equal(result.error, 'plain string');
});

test('the summary line names each section, its counts, and what failed', () => {
  const ok = summarizeInit([
    { name: 'Temporary label station list', ok: true, detail: '27 stations' },
    { name: 'Printer list', ok: true, detail: '9 printer(s)' }
  ], 1234);
  assert.equal(ok.level, 'info');
  assert.match(ok.message, /completed in 1234ms - all 2 sections loaded/);
  assert.match(ok.message, /Temporary label station list: 27 stations/);
  assert.match(ok.message, /Printer list: 9 printer\(s\)/);

  const failed = summarizeInit([
    { name: 'Temporary label station list', ok: true, detail: '27 stations' },
    { name: 'Printer list', ok: false, error: 'timed out' }
  ], 50);
  assert.equal(failed.level, 'warn');
  assert.match(failed.message, /1 of 2 section\(s\) failed/);
  assert.match(failed.message, /Printer list: FAILED \(timed out\)/);
});
