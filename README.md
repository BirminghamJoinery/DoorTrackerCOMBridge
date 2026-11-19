# Door Tracker COM Bridge

The one Windows desktop app for the workshop PC:

- **Scanning** — a NETUM NT-1228BL barcode/QR scanner over a Windows COM/serial
  port. Lists available ports, connects at a chosen baud rate, and shows each
  completed scan (terminated by CR, LF, or CRLF) in a live log, sent on to the
  Door Production Tracker website.
- **Label printing** — delivery labels rendered by the website, sent here and
  printed on a Zebra GK420D via raw ZPL (bypassing the Windows print driver).
- **Delivery Photos** — an entirely local service: an iPad on the same
  workshop Wi-Fi scans a delivery note's Data Matrix or QR code, takes photographs,
  and this PC files them straight onto the company network drive. No cloud,
  no website involved in the photo transfer at all — it works even with the
  website completely unreachable. See
  [`src/delivery-photos/README.md`](src/delivery-photos/README.md) for how
  that piece works.

Scanning/printing and Delivery Photos are deliberately isolated from each
other: Delivery Photos runs as a **separate forked process**, supervised by
this app and restarted automatically if it ever crashes, so a problem with
the network drive or the local Wi-Fi server can never stall a COM port read
or a print job, and vice versa.

## Run in development

```bash
npm install
npm test    # see "Delivery Photos" below for what this exercises
npm start
```

This launches the app via Electron directly from source — use this while
making changes to the COM port, printing, or Delivery Photos logic.

If the window never opens and Electron behaves like plain Node, the shell has
`ELECTRON_RUN_AS_NODE` set. VS Code sets it for processes started by
extensions (including AI coding assistants' terminals); VS Code's own
integrated terminal removes it. Clear it for that shell first:
`Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) or
`unset ELECTRON_RUN_AS_NODE` (macOS/Linux).

**Building the installer on your own Windows PC** (`npm run dist:win`) needs
permission to create symbolic links, because electron-builder unpacks a
code-signing toolkit that contains some. Turn on **Settings → System → For
developers → Developer mode** (one-time; needs administrator approval), then
run it from a normal, non-elevated terminal. GitHub Actions needs nothing.

## Delivery Photos

Configured from its own tab in the app (**Delivery Photos**): a local
hostname (e.g. `door-tracker.local`, advertised via mDNS — bundled in this
app, nothing extra to install), a port, and the network archive folder (a
`\\server\share\...` UNC path or a mapped drive letter such as
`S:\Delivery Photographs`). "Start Photo Service" begins listening; the
panel shows the address to open on the iPad, **Orders filed today** and the
Google Sheet sync status.

### Photo roles and how photographs are filed

Every iPad is paired as one of three **photo roles**, chosen on this PC
under **Pair a New iPad** and fixed to that iPad until it is removed (the
iPad cannot choose or change it):

| Role | Scans | Example | Files as |
|---|---|---|---|
| Delivery | the delivery note | `5698-P2-DELIV` | `001-DELIV.jpg` |
| Bench | a door or frame production label | `5698-D`, `5626-2-F` | `002-BENCH.jpg` |
| Ironmongery | an order number (scanned or typed) | `5698`, `5626-2` | `003-IRN.jpg` |

Every photograph, whatever its role, goes into ONE folder per order, named
with the base order number only - `S:\Delivery Photographs\5698\` or
`...\5626-2\` - and is numbered across the whole folder, so Delivery, Bench
and Ironmongery photos of one order sit side by side in the order taken
(`001-DELIV.jpg`, `002-BENCH.jpg`, `003-IRN.jpg`, `004-DELIV.jpg`...).
Folders from before this layout (`5698-DELIV\photo-001.jpg`) are left
exactly as they are.

Only Delivery sessions are tracked in the Google Sheet (DELIVERY_PHOTO_SCANS,
with Full/Part details from the delivery code) and counted in **Orders filed
today**. To give an iPad a different role, **Remove** it from the Paired
iPads list and pair it again with the new role.

The iPad needs its camera to work, which requires a genuine secure (HTTPS)
context — the app is its own tiny certificate authority for this, and an
iPad only ever has to trust it once (open the address shown, install the one
certificate profile Safari offers, then flip the "Full Trust" toggle in
Settings → General → About → Certificate Trust Settings). Every visit after
that is a normal, un-scary HTTPS connection.

### Away from the workshop (offline capture)

The iPad tool keeps working with no connection to this PC. Photographs taken
while the Photo Service cannot be reached are saved on the iPad (in that
site's own browser storage, IndexedDB) and sent automatically the next time
the tool is open on the workshop Wi-Fi - for all three roles. A delivery only counts as filed, and
only gets its Google Sheet row, once every photograph has been verified on
the company drive.

One-time setup, **on the workshop Wi-Fi**:

1. Open the address shown in the app in Safari and pair the iPad as usual
   (choosing its role on the PC first).
2. Share → **Add to Home Screen**, then open **Delivery Photos** from the
   Home Screen and pair it once more, with the same role (a Home Screen app has its own storage,
   separate from Safari's - use only the Home Screen app from then on).
3. On its pending screen, "Opens without the workshop PC" should say **yes**.

Pending deliveries are sent only while the tool is open and in the
foreground (iPadOS does not reliably run web apps in the background).
Photographs waiting on the iPad can be seen by anyone who can unlock it and
open the tool, so keep the iPad passcode-locked.

`npm test` runs everything for Delivery Photos too: real forked worker
processes doing real file I/O, a real generated certificate genuinely
TLS-handshaked over localhost, a real local HTTPS server handling real photo
uploads end-to-end, and a real UDP mDNS round-trip (this last one skips
cleanly rather than failing on a machine/network that does not allow
multicast — see `src/delivery-photos/mdns.test.js`). The offline tests also
drive the real iPad page in headless Google Chrome
(`src/delivery-photos/offline-browser.test.js`), skipping cleanly if Chrome is
not installed.

## Temporary Data Matrix Printing

When a scanner at an enabled station scans an order's general door code -
`5698-D` or `5626-2-D` (four digits, an optional 1-3 digit call-off, then
exactly `-D`) - the station's own USB printer prints that order's
**temporary labels**: one centred Data Matrix per label, encoding exactly
`5698-T-01`, `5698-T-02`, ... (`5626-2-T-01`, ... for a call-off) and nothing
else. Numbers are two digits up to 99, then `100`, `101`, ... Individual door
codes (`5698-D-01`), frame (`-F`), delivery (`-DELIV`) and temporary (`-T-01`)
codes never trigger it. The scan is still sent to the website exactly as
before; printing is an extra action that never blocks or fails it.

**Quantity source:** a Google Sheet with the header row
`Order Number | Temp Label Qty` (columns A and B), read by the website with its
existing service account through `GET /api/temp-labels`. This app fetches it
from the Server API URL's site at start-up, every 5 minutes and on **Refresh
Label Data**, and keeps a local copy (`temp-labels-cache.json` in the
user-data folder) that scans read - so printing keeps working with the
internet down, and after a restart. A failed refresh keeps the last good copy.
If the copy is more than 24 hours old the app warns
("Cached label data is over 24 hours old") but keeps printing from it.
Quantities must be whole numbers 1-200; blank, text, zero, negative or larger
values are refused and logged, and an order listed twice with different
quantities is refused until the sheet is fixed.

**Website access key:** `/api/temp-labels` only answers a request carrying
`Authorization: Bearer <key>` - the same scheme as the Photo Bridge endpoints.
Press **Generate Access Key** in the app: it makes a random key, stores it
encrypted for this Windows user (DPAPI) in `temp-labels-access-key.json`, and
shows only the key's SHA-256. Put that SHA-256 in the website's
`TEMP_LABELS_KEY_SHA256` setting (several, comma-separated, if more than one
PC). The key itself is never shown, logged or sent anywhere else. Without a
matching setting the website refuses the request (401), or refuses everyone
if `TEMP_LABELS_KEY_SHA256` is not set (503).

**Printing:** the station's printer is named exactly - there is no fallback
to the main printer or the Windows default - and checked just before sending;
a missing or offline printer (as Windows reports it) refuses the batch. Each
scan's labels go to the printer as one raw ZPL job (native `^BX` Data Matrix)
named **Temporary Labels - <order>** in the Windows print queue, one batch at
a time. The same order at the same station on the same printer is ignored for
45 seconds after a successful batch; a failed batch can be rescanned at once.

Set it up under **Printing > Temporary Data Matrix Printing**: station,
**Enable temporary label printing**, printer, **Save Station**. The label
layout (size, module size, X/Y offset) starts from the GK420D's existing
89x36mm setup and can be adjusted; **Test Temporary Label** prints one label
with a typed code on a saved station's printer. Remote Admin cannot change any
of this.

## Remote Admin (COM connections from another PC)

Lets the scanner connections be checked and controlled from a normal
browser on another computer on the company network (e.g. upstairs) - no
Remote Desktop, no domain membership needed. It covers the **COM
connections only**: status (connected/disconnected/error, last scan, last
error), Connect / Disconnect / Reconnect one port, Restart scanner
subsystem (every connected or failed port), Refresh ports, edit a
connection's COM port / station / baud rate, add or remove a connection,
and the recent COM Bridge log and Remote Admin audit log. It cannot send
anything to a serial port, run programs, browse files, reboot the PC, or
change Delivery Photos.

**Switching it on** (Windows app, **Remote Admin** tab, on this PC only):

1. Set an admin password (at least 8 characters - an 8-digit PIN is the
   shortest accepted). Only a salted scrypt hash is stored.
2. Tick **Allow Remote Admin from the local network**, keep port **8445**
   (or choose another) and Save.
3. On the other PC open one of the addresses shown, e.g.
   `https://<COMPUTERNAME>:8445/admin/` or `https://<laptop IP>:8445/admin/`.

Remote Admin can never change its own password, port or on/off switch -
only this Windows app can. Changing the password signs every browser out;
**Sign Out All Remote Sessions** does the same without changing it.

**Security, in brief.** It runs as its own forked process
(`src/remote-admin/admin-entry.js`), supervised like Delivery Photos, so
TLS/HTTP/sign-in never run inside the process that reads the serial ports.
That process can only ask the app to do one of a fixed list of actions
(`src/remote-admin/actions.js`), which re-validates everything with the
same settings code the Windows tabs use (`src/com-settings.js`,
`src/com-options.js`). Connections from anything but a private / link-local
/ loopback address are dropped before TLS; the Host header must name this
PC; sign-in is limited to 5 failures per address (25 overall) per 15
minutes; sessions are HttpOnly + Secure + SameSite=Strict cookies that end
after 30 idle minutes or 8 hours; every change needs a same-origin Origin
header, a JSON body, the session's CSRF token, and stays under 8 KB.
Disruptive actions (disconnecting or reconnecting a working port, changing
a COM port, removing a connection, restarting all) must be confirmed. Every
sign-in and action is written to `logs/remote-admin-YYYY-MM-DD.log` with
the client's IP and the outcome - never a password or token. An iPad's
Delivery Photos pairing token grants nothing here.

**Windows Firewall.** The app never changes the firewall. Remote Admin
needs inbound TCP on its port (default 8445) from the local network. Windows
may show its own "allow access" prompt the first time it listens: allow
**Private** networks only, never Public. Or add the rule yourself in an
elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Door Tracker COM Bridge Remote Admin" -Direction Inbound -Protocol TCP -LocalPort 8445 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

A PC that is not joined to the domain never uses the Domain profile, so
this rule applies only while the laptop's network is set to **Private**.
If Windows has it as Public, the rule does not apply. Changing that is
deliberately left to you.

**Certificate warning.** Remote Admin has its own small local certificate
authority (same code as Delivery Photos, its own files). To avoid the
browser warning on the other PC, download `/admin/ca.crt` from the admin
page, check its SHA-256 fingerprint matches the one in the Remote Admin
tab, and import it into that PC's *Trusted Root Certification Authorities*
store. Otherwise expect the warning on each visit.

**Not included:** restarting the whole COM Bridge app remotely. A portable
`.exe` cannot reliably relaunch itself (it runs from a temporary extracted
copy), so it could leave the app not running with nobody downstairs to
start it again. Restart scanner subsystem covers the scanner side.

## Build the Windows version

```bash
npm run dist:win
```

This produces both a portable `.exe` and an NSIS setup installer `.exe` for
Windows x64, with Delivery Photos' web assets (the iPad-facing page, the
bundled barcode-scanning library) bundled unpacked alongside the app so the
local server can serve them directly. Other scripts available:

- `npm run pack` — unpacked local build for the current platform, useful for
  a quick sanity check without producing installers.
- `npm run dist` — build for whatever platform electron-builder defaults to
  on the current OS.
- `npm run dist:win` — Windows portable `.exe` + NSIS installer `.exe`
  (works even when run from macOS or Linux — electron-builder downloads its
  own bundled Wine/NSIS toolchain automatically).

The GitHub Actions build (`.github/workflows/build-windows.yml`) runs the
full test suite on a real Windows machine first — **a failing test fails the
whole build**, so a package is never published from code whose tests did not
pass — then verifies the Delivery Photos web assets, the in-app updater's
release files (with a `latest.yml` whose SHA-512 really matches the
installer) and the Remote Admin files really made it into the built package
(`scripts/verify-package.js`), before uploading the artifact.

## Where the built files appear

Everything lands in the `dist/` folder at the project root, including:

- `DoorTrackerCOMBridge-Setup-<version>.exe` — NSIS installer that installs
  the app and creates shortcuts. **Use this for production** - it is the
  only build the Updates tab can update.
- `DoorTrackerCOMBridge-Setup-<version>.exe.blockmap` and `latest.yml` —
  update metadata the in-app updater needs (attach both to every release).
- `DoorTrackerCOMBridge-Portable-<version>.exe` — portable build, no
  installation required, for troubleshooting; it cannot update itself.
- `dist/win-unpacked/` — the raw unpacked app (used internally, not meant for
  distribution).

`dist/` is git-ignored and regenerated on every build.

## Updates (GitHub Releases)

The **Updates** tab installs a packaged release from this repository's
[GitHub Releases](https://github.com/BirminghamJoinery/DoorTrackerCOMBridge/releases) -
never source code from `main`. Nothing happens on its own: **Check for
Updates**, **Download Update** and **Restart and Install** are each a button
press, and the install is confirmed first ("The COM Bridge will close
briefly…", with the number of open scanner connections and print jobs in
progress). Remote Admin cannot check for, download or install updates.

- **Which releases count:** published, not drafts, not pre-releases, tagged
  `vMAJOR.MINOR.PATCH`, and carrying `DoorTrackerCOMBridge-Setup-<version>.exe`
  and `latest.yml` from this repository's own release. Versions compare
  numerically (1.10.0 is newer than 1.9.9).
- **Previous Versions** lists recent stable releases, older ones included;
  choosing an older one is a rollback and asks for confirmation first. Settings
  are not converted back - an older version may ignore options added later.
- **Verification:** the download is checked by electron-updater against the
  SHA-512 in that release's `latest.yml` before it can be installed; a failed
  or mismatched download changes nothing. Releases are **not code-signed**.
- **Install:** electron-updater runs the installer silently over the existing
  installation and starts the app again. Settings, logs, certificates, paired
  iPads and Delivery Photos state all live in `%APPDATA%\Door Tracker COM
  Bridge` and are never touched by installing, upgrading or downgrading
  (`deleteAppDataOnUninstall` is off). Activity is logged to
  `logs\updater-YYYY-MM-DD.log` there.
- **Portable build:** cannot update itself; the tab explains this. Install
  the Setup exe once instead - it uses the same settings.

### Publishing a release

1. Set `"version"` in `package.json` (e.g. `1.3.0`), run `npm install` so the
   lock file matches, commit and push to `main`.
2. Tag that commit and push the tag: `git tag v1.3.0 && git push origin v1.3.0`.
3. GitHub Actions runs the tests, builds, verifies the package and then
   creates a **draft** release `v1.3.0` with the Setup exe, its `.blockmap`,
   `latest.yml`, the portable exe and `SHA256SUMS.txt`. A failed test/build or
   a tag that does not match `package.json` creates nothing.
4. Check the draft on GitHub, add notes if you like, and press **Publish
   release**. Only then does the Updates tab see it.

## Unsigned app warning

This app is not code-signed. When you run either `.exe` on a Windows machine,
**Windows SmartScreen will likely show a "Windows protected your PC"
warning.** This is expected for an unsigned app — click **More info → Run
anyway** to proceed. Code signing is intentionally out of scope for this stage.

## Which build to test first

For a quick try-out, the **portable `.exe`** needs no installation - just run
it. For the production PC use the **Setup** installer: only an installed copy
can be updated (or rolled back) from the Updates tab.
