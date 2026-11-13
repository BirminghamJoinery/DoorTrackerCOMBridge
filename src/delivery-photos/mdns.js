'use strict';

// Advertises this PC's local hostname (e.g. "door-tracker.local") on the
// workshop network via mDNS, so the iPad can find it by name without any
// extra software - iPadOS resolves ".local" names natively. Windows itself
// does not broadcast mDNS out of the box (confirmed before writing this),
// so this program carries its own small responder rather than asking anyone
// to install Apple's Bonjour separately.

const os = require('node:os');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'delivery-photos';

// A small utility for anyone needing the bare label (e.g. for display).
// NOT used when calling bonjour-service below - confirmed by a real mDNS
// query before writing this: its `host` option is used VERBATIM as the
// address record's own name, it does NOT append ".local" itself (despite
// most examples passing a bare label) - so the full "door-tracker.local"
// form must be passed to advertise() below, never stripped.
function stripLocalSuffix(hostname) {
  return hostname.replace(/\.local$/i, '');
}

// Adapters an iPad on the workshop Wi-Fi can never reach - Hyper-V / WSL /
// Docker virtual switches, VirtualBox / VMware host-only networks, VPN and
// tunnel adapters. Left to itself, bonjour-service answers ".local" queries
// with EVERY address on the PC, so the iPad could be handed one of these and
// sit trying to connect to it while the real LAN address works fine.
const VIRTUAL_ADAPTER_PATTERN = /(vEthernet|Hyper-V|VirtualBox|VMware|VMnet|WSL|Docker|Loopback|Bluetooth|TAP-|Tailscale|ZeroTier|WireGuard|OpenVPN|VPN|Npcap|Teredo|isatap|utun|bridge100)/i;

// The IPv4 addresses worth advertising, from os.networkInterfaces() shape:
// never loopback/internal, never link-local (169.254.x.x - an adapter with no
// DHCP lease), and adapters that look virtual are only used if there is
// nothing else at all. Sorted, so two calls can be compared.
function lanAddresses(interfaces) {
  const preferred = new Set();
  const fallback = new Set();
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const addr of addresses || []) {
      if (!addr || (addr.family !== 'IPv4' && addr.family !== 4) || addr.internal) continue;
      if (/^169\.254\./.test(addr.address) || /^127\./.test(addr.address)) continue;
      fallback.add(addr.address);
      if (!VIRTUAL_ADAPTER_PATTERN.test(name)) preferred.add(addr.address);
    }
  }
  return [...(preferred.size > 0 ? preferred : fallback)].sort();
}

// Starts advertising and returns a handle with stop(). Publishing a real
// service (not just the bare hostname) is what makes bonjour-service answer
// A-record queries for the host at all, and is a harmless, useful bonus in
// its own right (a future "find my Photo service on the network" tool could
// browse for `_delivery-photos._tcp.local` instead of needing to already
// know the hostname).
//
// Only lanAddresses() are advertised (IPv4 only - the certificate, the iPad
// and the workshop network all work over IPv4), and the addresses are looked
// at again every `recheckMs`: if they change (a new DHCP lease, Wi-Fi vs
// cable, a VPN coming up) the service is re-announced with the new ones, so
// the iPad is never left resolving the name to an address the PC no longer
// has. Every set of addresses advertised is written to the log.
function advertise({ hostname, port, logger, getInterfaces = () => os.networkInterfaces(), recheckMs = 30000 }) {
  const log = logger || { info() {}, warn() {} };
  const bonjour = new Bonjour();
  let service = null;
  let current = [];
  let stopped = false;

  function publish() {
    current = lanAddresses(getInterfaces());
    const advertised = current;
    service = bonjour.publish({ name: 'Door Tracker Delivery Photos', type: SERVICE_TYPE, port, host: hostname, disableIPv6: true });
    // bonjour-service builds its A records from every interface; keep only
    // the ones chosen above. Done before its first announcement, which
    // always waits for its own name probe to finish first.
    const allRecords = service.records.bind(service);
    service.records = () => allRecords().filter((record) => record.type !== 'A' || advertised.includes(record.data));
    if (advertised.length > 0) log.info(`Advertising ${hostname} on the local network as ${advertised.join(', ')} (port ${port}).`);
    else log.warn(`Advertising ${hostname}, but this PC has no usable network address right now - iPads cannot find it by name until it has one.`);
  }

  publish();

  const timer = setInterval(() => {
    if (stopped) return;
    let next;
    try {
      next = lanAddresses(getInterfaces());
    } catch {
      return;
    }
    if (next.join(',') === current.join(',')) return;
    log.info(`This PC's network addresses changed (${current.join(', ') || 'none'} -> ${next.join(', ') || 'none'}) - re-announcing ${hostname}.`);
    const old = service;
    old.stop(() => {
      if (!stopped) publish();
    });
  }, recheckMs);
  if (timer.unref) timer.unref();

  return {
    addresses: () => current.slice(),
    // The DNS records currently being answered with (diagnostics / tests).
    records: () => service.records(),
    stop() {
      stopped = true;
      clearInterval(timer);
      return new Promise((resolve) => {
        service.stop(() => bonjour.destroy(() => resolve()));
      });
    }
  };
}

module.exports = { advertise, lanAddresses, SERVICE_TYPE, stripLocalSuffix };
