'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');

const { testNetworkStorage, StorageTestError } = require('./storage-test');
const fsOps = require('./fs-ops');
const { runInWorker } = require('./worker-runner');
const { makeEnv } = require('./helpers');

// S:\ is SIMULATED, never looked up for real: whichever PC runs the tests may
// have S: mapped to the real company share, and this storage test WRITES a
// dummy photograph to any folder it can reach. An lstat under S:\ fails the
// way a missing folder does, and the drive's own state comes from
// `driveConnected`. Every other path still uses the real filesystem.
// Returns the drive letters the code asked about.
function simulateSDrive(t, { driveConnected }) {
  const realLstat = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (p, ...rest) => {
    if (String(p).toUpperCase().startsWith('S:\\')) throw Object.assign(new Error('ENOENT: no such file or directory (simulated)'), { code: 'ENOENT' });
    return realLstat.call(fsp, p, ...rest);
  });
  const drivesChecked = [];
  t.mock.method(fsOps, 'driveRootReachable', async (drive) => {
    drivesChecked.push(drive);
    return driveConnected;
  });
  return drivesChecked;
}

test('a working folder passes every step and cleans up its own test folder afterwards', async () => {
  const env = makeEnv();
  try {
    const result = await testNetworkStorage({ root: env.share });
    assert.equal(result.ok, true);
    assert.ok(result.steps.every((s) => s.ok));
    assert.ok(result.steps.some((s) => s.label.includes('verified')));

    // .incoming is the SAME shared staging folder the real archive engine
    // uses for every photograph (see fs-ops.js/archive.js) - it is meant to
    // stay, so only the test's own dated folder is checked for.
    const remaining = fs.readdirSync(env.share);
    assert.ok(!remaining.some((name) => name.startsWith('_delivery-photos-test-')), `left a test folder behind: ${remaining}`);
  } finally {
    env.cleanup();
  }
});

test('a missing folder fails clearly at the "reachable" step, before writing anything', async () => {
  const env = makeEnv();
  try {
    await assert.rejects(testNetworkStorage({ root: nodePath.join(env.share, 'missing') }), (err) => {
      assert.ok(err instanceof StorageTestError);
      assert.equal(err.step, 'reachable');
      return true;
    });
  } finally {
    env.cleanup();
  }
});

test('a mapped drive letter is accepted by the root/shape check, same as a UNC path', async (t) => {
  // Forces simulated Windows rules explicitly (platform: 'win32') rather than
  // relying on whatever OS happens to run this test. The Delivery Photos
  // worker always runs forked from the interactive, logged-in COM Bridge
  // app, so it sees the same drive mappings as whoever set this up - a
  // drive letter is a legitimate production archive root, not just a UNC
  // path. It gets past the shape check and fails at the "reachable" step
  // because S: is simulated as disconnected, and the message names the
  // drive it is waiting for.
  const drivesChecked = simulateSDrive(t, { driveConnected: false });
  await assert.rejects(testNetworkStorage({ root: 'S:\\Photos', platform: 'win32' }), (err) => {
    assert.ok(err instanceof StorageTestError);
    assert.equal(err.step, 'reachable');
    assert.match(err.message, /Network drive unavailable — waiting for S:/);
    return true;
  });
  assert.deepEqual(drivesChecked, ['S']);

  const env = makeEnv();
  try {
    await assert.doesNotReject(testNetworkStorage({ root: env.share }));
  } finally {
    env.cleanup();
  }
});

test('a connected drive letter whose folder is missing fails at "reachable" without blaming the drive or writing anything', async (t) => {
  const drivesChecked = simulateSDrive(t, { driveConnected: true });
  const mkdir = t.mock.method(fsp, 'mkdir');
  await assert.rejects(testNetworkStorage({ root: 'S:\\Photos', platform: 'win32' }), (err) => {
    assert.ok(err instanceof StorageTestError);
    assert.equal(err.step, 'reachable');
    assert.match(err.message, /The S: drive is connected, but the configured folder does not exist on it\./);
    assert.doesNotMatch(err.message, /Network drive unavailable/);
    return true;
  });
  assert.deepEqual(drivesChecked, ['S']);
  assert.equal(mkdir.mock.callCount(), 0, 'nothing may be created when the folder is not reachable');
});

test('an existing, unrelated file in the archive folder is left completely alone', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(nodePath.join(env.share, 'do-not-touch.txt'), 'important customer data');
    await testNetworkStorage({ root: env.share });
    assert.equal(fs.readFileSync(nodePath.join(env.share, 'do-not-touch.txt'), 'utf8'), 'important customer data');
  } finally {
    env.cleanup();
  }
});

test('runs correctly through the real forked worker process, exactly as the Electron UI would call it', async () => {
  const env = makeEnv();
  try {
    const result = await runInWorker('storage-test', { root: env.share }, { timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.ok(!fs.readdirSync(env.share).some((name) => name.startsWith('_delivery-photos-test-')));
  } finally {
    env.cleanup();
  }
});
