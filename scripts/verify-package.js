#!/usr/bin/env node
'use strict';

// Run by CI right after `npm run dist:win` (see .github/workflows/build-windows.yml):
// checks the BUILT Windows package, not the source tree, for the things a
// packaging mistake would silently drop and no unit test would notice -
//   - the release assets the in-app updater looks for, under the exact names
//     src/updater/releases.js expects;
//   - latest.yml naming that installer, with a SHA-512 that really matches it
//     (what electron-updater verifies every download against);
//   - app-update.yml inside the app;
//   - the updater, Remote Admin (including its web page), Temporary Data
//     Matrix Printing, Delivery Photos (worker code inside app.asar, the iPad
//     web page in app.asar or app.asar.unpacked) and shared COM code, and
//     electron-updater itself.
// Exits non-zero, listing every problem, if anything is missing or wrong.
//
//   node scripts/verify-package.js [distDir]

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const asar = require('@electron/asar');
const { installerName, OWNER, REPO } = require('../src/updater/releases');

const root = nodePath.join(__dirname, '..');
const dist = nodePath.resolve(process.argv[2] || nodePath.join(root, 'dist'));
const { version } = require('../package.json');
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

const setup = installerName(version);
const assets = [setup, `${setup}.blockmap`, 'latest.yml', `DoorTrackerCOMBridge-Portable-${version}.exe`];
for (const name of assets) check(fs.existsSync(nodePath.join(dist, name)), `Missing release asset: dist/${name}`);

const latestPath = nodePath.join(dist, 'latest.yml');
if (fs.existsSync(latestPath) && fs.existsSync(nodePath.join(dist, setup))) {
  const yml = fs.readFileSync(latestPath, 'utf8');
  check(new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml), `latest.yml is not for version ${version}`);
  check(yml.includes(`- url: ${setup}\n`), `latest.yml does not name ${setup}`);
  const declared = /^\s+sha512: (\S+)$/m.exec(yml);
  const actual = crypto.createHash('sha512').update(fs.readFileSync(nodePath.join(dist, setup))).digest('base64');
  check(declared && declared[1] === actual, `latest.yml's SHA-512 does not match ${setup}`);
}

const resources = nodePath.join(dist, 'win-unpacked', 'resources');
const updateConfig = nodePath.join(resources, 'app-update.yml');
if (check(fs.existsSync(updateConfig), 'Missing win-unpacked/resources/app-update.yml')) {
  const text = fs.readFileSync(updateConfig, 'utf8');
  // Must be the same repository the in-app updater checks (src/updater/releases.js).
  check(new RegExp(`^owner: ${OWNER}$`, 'm').test(text) && new RegExp(`^repo: ${REPO}$`, 'm').test(text), `app-update.yml does not point at ${OWNER}/${REPO}`);
}

const asarPath = nodePath.join(resources, 'app.asar');
if (check(fs.existsSync(asarPath), 'Missing win-unpacked/resources/app.asar')) {
  const files = new Set(asar.listPackage(asarPath).map((f) => f.split(nodePath.sep).join('/')));
  const required = [
    '/src/main.js',
    '/src/preload.js',
    '/src/index.html',
    '/src/renderer.js',
    '/src/com-options.js',
    '/src/init-sections.js',
    '/src/com-settings.js',
    '/src/updater/releases.js',
    '/src/updater/update-controller.js',
    '/src/remote-admin/actions.js',
    '/src/remote-admin/admin-auth.js',
    '/src/remote-admin/admin-certs.js',
    '/src/remote-admin/admin-config.js',
    '/src/remote-admin/admin-entry.js',
    '/src/remote-admin/admin-server.js',
    '/src/remote-admin/log-reader.js',
    '/src/remote-admin/net-guard.js',
    '/src/remote-admin/web/index.html',
    '/src/remote-admin/web/admin.js',
    '/src/remote-admin/web/admin.css',
    '/src/scan-actions.js',
    '/src/retired-files.js',
    '/src/delivery-photos/worker-entry.js',
    '/src/delivery-photos/worker.js',
    '/src/delivery-photos/http-server.js',
    '/src/delivery-photos/web-shell.js',
    '/src/temp-labels/access-key.js',
    '/src/temp-labels/codes.js',
    '/src/temp-labels/settings.js',
    '/src/temp-labels/source-cache.js',
    '/src/temp-labels/trigger.js',
    '/src/temp-labels/zpl.js',
    '/node_modules/electron-updater/package.json',
    '/node_modules/electron-updater/out/main.js'
  ];
  for (const file of required) check(files.has(file), `Missing from app.asar: ${file}`);

  // The Delivery Photos iPad page is asarUnpack'ed (package.json), so it may
  // be listed in app.asar, extracted to app.asar.unpacked, or both - any of
  // those is reachable at run time; missing from both is not.
  const unpacked = nodePath.join(resources, 'app.asar.unpacked');
  const deliveryPhotosWeb = [
    'index.html', 'app.js', 'camera.js', 'offline-queue.js', 'scanner.js', 'style.css', 'sw.js',
    'manifest.webmanifest', 'vendor/zxing/zxing-reader.js', 'vendor/zxing/zxing_reader.wasm'
  ];
  for (const name of deliveryPhotosWeb) {
    const rel = `/delivery-photos-web/${name}`;
    check(files.has(rel) || fs.existsSync(nodePath.join(unpacked, 'delivery-photos-web', ...name.split('/'))), `Missing Delivery Photos web asset: ${rel}`);
  }
  check(![...files].some((f) => f.endsWith('.test.js')), 'app.asar contains test files');
}

// ---- Electron runtime files ----
//
// Door Tracker COM Bridge.exe cannot even start without the Electron
// runtime files next to it: Windows refuses to load it if ffmpeg.dll is
// missing ("The code execution cannot proceed because ffmpeg.dll was not
// found"), and Chromium needs libEGL/libGLESv2, icudtl.dat, the V8 snapshots
// and the .pak files as soon as it starts. The reference is the installed
// Electron package's own dist folder (node_modules/electron/dist - the same
// official release zip electron-builder packages): every runtime file in it
// must be in win-unpacked byte-for-byte (SHA-256), and in the Setup and
// Portable exes with the same size and CRC-32 - so a missing file, or one
// from a different Electron version, fails the build.
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { productName } = require('../package.json').build;

const electronDir = nodePath.join(root, 'node_modules', 'electron');
const electronDist = nodePath.join(electronDir, 'dist');
const electronVersion = require(nodePath.join(electronDir, 'package.json')).version;

// Files of the Electron zip that electron-builder deliberately does not ship
// as-is: electron.exe becomes "<productName>.exe" (checked separately - its
// icon/version resources differ), LICENSE becomes LICENSE.electron.txt,
// `version` and the default app are dropped.
const NOT_SHIPPED_AS_IS = new Set(['electron.exe', 'LICENSE', 'version', 'resources/default_app.asar']);

// Never allowed to be missing, even if the reference folder itself were
// incomplete (an interrupted Electron postinstall - see build-windows.yml).
const ALWAYS_REQUIRED = [
  'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vulkan-1.dll',
  'vk_swiftshader_icd.json', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'locales/en-US.pak'
];

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(nodePath.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const crc32 = (file) => (typeof zlib.crc32 === 'function' ? (zlib.crc32(fs.readFileSync(file)) >>> 0).toString(16).toUpperCase().padStart(8, '0') : null);

// The files inside an electron-builder Setup/Portable exe (its embedded 7z
// archive), listed with the 7-Zip electron-builder itself uses:
// { 'path/inside': { size, crc } }.
function listExe(exePath) {
  const sevenZip = require('7zip-bin').path7za;
  const text = execFileSync(sevenZip, ['l', '-slt', '-ba', exePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = {};
  for (const block of text.split(/\r?\n\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^(\w[\w ]*?) = (.*)$/.exec(line);
      if (m) fields[m[1]] = m[2];
    }
    if (!fields.Path || /D/.test(fields.Attributes || '')) continue;
    entries[fields.Path.split('\\').join('/')] = { size: Number(fields.Size), crc: (fields.CRC || '').toUpperCase() || null };
  }
  return entries;
}

let runtimeFiles = 0;
if (check(fs.existsSync(electronDist), `Missing the Electron reference folder ${electronDist} - run npm ci`)) {
  const distVersionFile = nodePath.join(electronDist, 'version');
  const distVersion = fs.existsSync(distVersionFile) ? fs.readFileSync(distVersionFile, 'utf8').trim() : null;
  check(distVersion === electronVersion, `node_modules/electron/dist is Electron ${distVersion || 'unknown'}, but the electron package is ${electronVersion} - reinstall it (npm ci)`);

  const reference = listFiles(electronDist).filter((rel) => !NOT_SHIPPED_AS_IS.has(rel));
  runtimeFiles = reference.length;
  for (const rel of ALWAYS_REQUIRED) check(reference.includes(rel), `The Electron ${electronVersion} reference folder itself has no ${rel} - its install is incomplete (npm ci)`);
  const exeName = `${productName}.exe`;

  const unpacked = nodePath.join(dist, 'win-unpacked');
  if (check(fs.existsSync(unpacked), 'Missing dist/win-unpacked')) {
    check(fs.existsSync(nodePath.join(unpacked, exeName)), `Missing from win-unpacked: ${exeName}`);
    for (const rel of reference) {
      const built = nodePath.join(unpacked, ...rel.split('/'));
      if (!check(fs.existsSync(built), `Missing Electron runtime file from win-unpacked: ${rel}`)) continue;
      check(sha256(built) === sha256(nodePath.join(electronDist, ...rel.split('/'))), `win-unpacked/${rel} is not Electron ${electronVersion}'s own file (SHA-256 differs)`);
    }
  }

  for (const exe of [setup, `DoorTrackerCOMBridge-Portable-${version}.exe`]) {
    const exePath = nodePath.join(dist, exe);
    if (!fs.existsSync(exePath)) continue; // already reported as a missing release asset
    let inside;
    try {
      inside = listExe(exePath);
    } catch (err) {
      check(false, `Could not list the files inside ${exe}: ${String(err.message || err).split('\n')[0]}`);
      continue;
    }
    check(Boolean(inside[exeName]), `Missing from ${exe}: ${exeName}`);
    for (const rel of reference) {
      const entry = inside[rel];
      if (!check(Boolean(entry), `Missing Electron runtime file from ${exe}: ${rel}`)) continue;
      const ref = nodePath.join(electronDist, ...rel.split('/'));
      const refSize = fs.statSync(ref).size;
      check(entry.size === refSize, `${rel} inside ${exe} is ${entry.size} bytes, Electron ${electronVersion}'s is ${refSize}`);
      const refCrc = crc32(ref);
      if (refCrc && entry.crc) check(entry.crc === refCrc, `${rel} inside ${exe} is not Electron ${electronVersion}'s own file (CRC-32 differs)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Package verification FAILED (${problems.length} problem(s)) for version ${version}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Package verification passed for version ${version}: release assets, update metadata (SHA-512 matches), app-update.yml, updater, Remote Admin, Temporary Data Matrix Printing and Delivery Photos files are all present, and all ${runtimeFiles} Electron ${electronVersion} runtime files (ffmpeg.dll, libEGL.dll, libGLESv2.dll, .pak files, ...) are in win-unpacked, the Setup exe and the Portable exe, matching Electron's own.`);
