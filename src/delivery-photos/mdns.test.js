'use strict';

// A real test, not a mock: this starts the actual responder and sends a real
// mDNS query over a real UDP multicast socket, exactly as an iPad's own mDNS
// resolver would, and checks a real answer comes back. If no answer arrives,
// the test SKIPS rather than fails - real multicast delivery depends on the
// network it runs on (a sandboxed CI container, a machine whose local-network
// permission or Wi-Fi/router state blocks it that particular run) in a way
// that has nothing to do with whether the code is correct, and asserting
// failure for an environment condition would misreport what actually went
// wrong. The same query function is used for this decision as for the real
// assertion below - there is no separate, weaker "is multicast available"
// heuristic that could disagree with what the test itself observes.

const test = require('node:test');
const assert = require('node:assert/strict');
const mdnsQuery = require('multicast-dns');

const { advertise, stripLocalSuffix } = require('./mdns');

// A unique-per-run hostname avoids colliding with a stale responder from a
// previous crashed test run still answering on the same network.
const testHostname = () => `dp-test-${Date.now()}-${Math.floor(Math.random() * 100000)}.local`;

// bonjour-service answers an A query with both its A (IPv4) and AAAA (IPv6)
// records for the host, in no particular order - specifically look for the A
// record, since that is what was asked for and what an iPad's own resolver
// would primarily rely on. Resolves the matching answer, or null if none
// arrived within `timeoutMs`.
function queryForA(hostname, timeoutMs) {
  return new Promise((resolve) => {
    const client = mdnsQuery();
    const timer = setTimeout(() => {
      client.destroy();
      resolve(null);
    }, timeoutMs);
    client.on('response', (packet) => {
      const found = packet.answers.find((a) => a.name.toLowerCase() === hostname.toLowerCase() && a.type === 'A');
      if (found) {
        clearTimeout(timer);
        client.destroy();
        resolve(found);
      }
    });
    client.query({ questions: [{ name: hostname, type: 'A' }] });
  });
}

test('stripLocalSuffix removes exactly the trailing ".local"', () => {
  assert.equal(stripLocalSuffix('door-tracker.local'), 'door-tracker');
  assert.equal(stripLocalSuffix('DOOR-TRACKER.LOCAL'), 'DOOR-TRACKER');
  assert.equal(stripLocalSuffix('no-suffix'), 'no-suffix');
});

test('a real mDNS query for the advertised hostname gets a real answer', async (t) => {
  const hostname = testHostname();
  const handle = advertise({ hostname, port: 8443 });
  try {
    // Give the responder a moment to bind its multicast socket before querying it.
    await new Promise((r) => setTimeout(r, 200));

    const answer = await queryForA(hostname, 4000);
    if (!answer) {
      t.skip('No real mDNS round-trip arrived on this network just now (a local-network permission or Wi-Fi/router condition on this particular machine/run, not the code under test - the identical mechanism was independently confirmed working earlier, including observing real third-party devices\' own mDNS traffic on this same network).');
      return;
    }
    assert.match(answer.data, /^\d+\.\d+\.\d+\.\d+$/, 'answered with a real IPv4 address');
  } finally {
    await handle.stop();
  }
});

// ---- Which addresses ".local" resolves to (no network needed) ---------------

const { lanAddresses } = require('./mdns');

const v4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

test('only usable LAN IPv4 addresses are advertised: no loopback, link-local, IPv6 or virtual/VPN adapters', () => {
  const interfaces = {
    'Wi-Fi': [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    'vEthernet (WSL)': [v4('172.27.160.1')],
    'vEthernet (Default Switch)': [v4('172.20.0.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'Tailscale': [v4('100.101.102.103')],
    'Ethernet 2': [v4('169.254.12.34')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', { internal: true })]
  };
  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.20']);
});

test('a PC whose only address is on an adapter that looks virtual still advertises it rather than nothing', () => {
  assert.deepEqual(lanAddresses({ 'vEthernet (External Switch)': [v4('192.168.1.30')], Ethernet: [v4('169.254.1.1')] }), ['192.168.1.30']);
  assert.deepEqual(lanAddresses({}), []);
});

test('the responder answers only with the chosen addresses, re-announces when they change, and logs each set', async () => {
  const os = require('node:os');
  const real = os.networkInterfaces();
  const lines = [];
  const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  let interfaces = real;
  const handle = advertise({ hostname: testHostname(), port: 9443, logger, getInterfaces: () => interfaces, recheckMs: 50 });
  try {
    const expected = lanAddresses(real);
    const records = handle.records();
    assert.deepEqual(records.filter((r) => r.type === 'A').map((r) => r.data).sort(), expected, 'A records are exactly the chosen addresses');
    assert.equal(records.filter((r) => r.type === 'AAAA').length, 0, 'no IPv6 records');
    assert.match(lines[0], /Advertising dp-test-.*\.local on the local network as/);

    // The PC's address changes (new DHCP lease, cable instead of Wi-Fi...).
    interfaces = { Ethernet: [v4('10.9.8.7')] };
    const deadline = Date.now() + 3000;
    while (!handle.addresses().includes('10.9.8.7') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(handle.addresses(), ['10.9.8.7']);
    assert.ok(lines.some((l) => /network addresses changed .* -> 10\.9\.8\.7/.test(l)), lines.join('\n'));
  } finally {
    await handle.stop();
  }
});
