// The Windows app's IPC contract, checked statically across main.js,
// preload.js and renderer.js so a removed feature cannot leave a dangling
// end behind: every channel the preload invokes has a main-process handler
// (and vice versa), every event main sends has a preload listener (and vice
// versa), every window.<api>.<method>() the renderer calls exists in the
// preload, and every element id the renderer looks up exists in index.html.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

// Line endings normalised: Windows CI checks the source out with CRLF.
const read = (name) => fs.readFileSync(nodePath.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer.js');
const html = read('index.html');

const all = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

// { apiName: Set(methodNames) } from the contextBridge.exposeInMainWorld blocks.
function preloadApi() {
  const api = {};
  let current = null;
  for (const line of preload.split('\n')) {
    const exposed = /exposeInMainWorld\('(\w+)'/.exec(line);
    if (exposed) {
      current = exposed[1];
      api[current] = new Set();
      continue;
    }
    const method = /^ {2}(\w+): /.exec(line);
    if (current && method) api[current].add(method[1]);
  }
  return api;
}

test('every invoked channel has a handler and every handler is invoked', () => {
  const handled = all(main, /ipcMain\.handle\('([^']+)'/g);
  const invoked = all(preload, /ipcRenderer\.invoke\('([^']+)'/g);
  assert.deepEqual(minus(invoked, handled), [], 'invoked with no handler');
  assert.deepEqual(minus(handled, invoked), [], 'handler nothing can reach');
});

test('every event main sends has a listener and every listener has a sender', () => {
  const sent = all(main, /(?:webContents\.send|sendToRenderer)\('([^']+)'/g);
  const listened = all(preload, /ipcRenderer\.on\('([^']+)'/g);
  assert.deepEqual(minus(sent, listened), [], 'sent with no listener');
  assert.deepEqual(minus(listened, sent), [], 'listener for an event never sent');
});

test('the renderer only calls preload methods that exist', () => {
  const api = preloadApi();
  assert.ok(Object.keys(api).length >= 5, 'found the exposed APIs');
  const missing = [...renderer.matchAll(/window\.(\w+)\.(\w+)\(/g)]
    .filter(([, name, method]) => name in api && !api[name].has(method))
    .map(([, name, method]) => `${name}.${method}`);
  assert.deepEqual(missing, []);
  const unknownApis = [...all(renderer, /window\.(\w+)\.\w+\(/g)].filter((n) => !(n in api) && !['ComOptions', 'navigator'].includes(n));
  assert.deepEqual(unknownApis, []);
});

test('every element id the renderer looks up exists in index.html', () => {
  const ids = all(renderer, /getElementById\('([^']+)'\)/g);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('nothing in the IPC contract belongs to the retired General Door Code Printing', () => {
  for (const [name, text] of [['main.js', main], ['preload.js', preload], ['renderer.js', renderer], ['index.html', html]]) {
    assert.doesNotMatch(text, /door-print|doorPrint|DoorPrint|general-door|generalDoor|GeneralDoor/, name);
  }
});
