// Windows-only printer access: enumerate installed printers, check whether
// a specific one exists/is online, and submit raw bytes to a named printer
// queue. Every exported function checks process.platform itself and
// returns a clear "not supported here" result on any other platform —
// nothing in this file ever throws just because it's running on macOS
// during development; it simply reports that it can't do anything real.
//
// No native Node dependency is used for any of this — each operation
// shells out to Windows' own PowerShell (present on every Windows install)
// via a small script, run once: printer DISCOVERY and the temporary-label
// printer check pass their script inline (-EncodedCommand, see listPrinters
// and checkPrinterForPrinting), getPrinterStatus and sendRawData write it to
// a temp file. This keeps the
// whole app installable/buildable with a single `npm install` on any
// platform (no node-gyp/native-module concerns for this feature), at the
// cost of one short-lived child process per call — entirely acceptable
// given how infrequently these operations run (once per print, plus
// occasional manual list/status checks).
//
// Raw submission specifically uses the long-standing Win32 "RawPrinterHelper"
// P/Invoke pattern (OpenPrinter/StartDocPrinter/WritePrinter/EndDocPrinter
// with datatype "RAW") — this bypasses the printer driver's own rendering
// entirely, which is what lets ZPL text reach the GK420D unmodified and
// with no print dialog, regardless of which Windows driver is associated
// with the queue.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { matchPrinterName } = require('./printer-names');

const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL_TIMEOUT_MS = 15000;
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// Windows PowerShell 5.1 sometimes reports errors on stderr as CLIXML
// ("#< CLIXML <Objs ...><S S="Error">text_x000D__x000A_</S>...") instead of
// plain text - turn that back into the readable lines.
function decodeClixml(text) {
  if (typeof text !== 'string' || !text.includes('#< CLIXML')) return text || '';
  const lines = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  if (lines.length === 0) return text;
  return lines
    .join('')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

const clip = (text, max = 2000) => (text.length > max ? `${text.slice(0, max)}...` : text);

// The JSON one of these scripts printed. Our scripts write only compact JSON
// ([Console]::Out.Write, UTF-8 without BOM), but a BOM, surrounding
// whitespace/CR-LF, or a stray line written by something else before or
// after it is tolerated: if the whole text is not JSON, the outermost {...}
// in it is tried. Anything else is a clear error naming `what`.
function parseJsonOutput(stdout, what) {
  const text = String(stdout || '').replace(/^﻿/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`${what} returned output that is not JSON: ${clip(text, 300)}`);
  }
}

// Turns a failed execFile() into an Error whose message says what actually
// happened - timed out, exit code N, plus PowerShell's own stderr - instead
// of Node's bare "Command failed: powershell.exe ..." (which is all anyone
// saw before whenever stderr was empty, e.g. when the process was killed).
// The raw facts are kept on err.diagnostics for logging.
function describePowerShellFailure({ err, stdout, stderr, timeoutMs, command, elapsedMs }) {
  const timedOut = Boolean(err && err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL'));
  const exitCode = err && typeof err.code === 'number' ? err.code : null;
  const errText = decodeClixml((stderr || '').trim()).trim();
  const outText = (stdout || '').trim();
  let summary;
  if (timedOut) summary = `PowerShell did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`;
  else if (exitCode !== null) summary = `PowerShell exited with code ${exitCode}`;
  else if (err && err.code === 'ENOENT') summary = 'powershell.exe could not be found on this PC';
  else summary = `PowerShell could not be run${err && err.code ? ` (${err.code})` : ''}`;
  const parts = [summary];
  if (errText) parts.push(clip(errText));
  else if (!timedOut) parts.push('(no error output)');
  const error = new Error(parts.join(': '));
  error.diagnostics = {
    command,
    exitCode,
    signal: (err && err.signal) || null,
    timedOut,
    elapsedMs,
    stdout: clip(outText, 1000),
    stderr: clip(errText, 2000)
  };
  return error;
}

// The printing path's runner (sendRawData, getPrinterStatus): unchanged
// apart from a clearer error message when PowerShell writes nothing to
// stderr. A script with something on stderr is reported exactly as before.
function runPowerShellScript(scriptContent, args = [], { timeoutMs = POWERSHELL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(os.tmpdir(), `combridge-ps-${randomUUID()}.ps1`);

    try {
      fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    } catch (err) {
      reject(new Error(`Could not write temporary PowerShell script: ${err.message}`));
      return;
    }

    const cleanup = () => fs.unlink(scriptPath, () => {});
    const started = Date.now();

    execFile(
      'powershell.exe',
      [...POWERSHELL_ARGS, '-File', scriptPath, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        cleanup();
        if (err) {
          const described = describePowerShellFailure({
            err, stdout, stderr, timeoutMs, elapsedMs: Date.now() - started,
            command: `powershell.exe ${POWERSHELL_ARGS.join(' ')} -File <temporary .ps1>`
          });
          const plainStderr = stderr && stderr.trim();
          const error = plainStderr ? new Error(plainStderr) : described;
          error.diagnostics = described.diagnostics;
          reject(error);
          return;
        }
        resolve((stdout || '').trim());
      }
    );
  });
}

// Runs a script passed inline with -EncodedCommand (base64 UTF-16LE, the
// form PowerShell itself documents for this). No temporary .ps1 is written,
// so nothing depends on %TEMP% being writable, on security software letting
// a freshly written script in %TEMP% run, or on execution policy (which
// governs script FILES, not -EncodedCommand).
function runPowerShellCommand(script, { timeoutMs = POWERSHELL_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `powershell.exe ${POWERSHELL_ARGS.join(' ')} -EncodedCommand <inline script, ${encoded.length} chars>`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      [...POWERSHELL_ARGS, '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(describePowerShellFailure({ err, stdout, stderr, timeoutMs, command, elapsedMs: Date.now() - started }));
          return;
        }
        resolve((stdout || '').trim());
      }
    );
  });
}

// How long Windows may take to report the optional per-printer details
// (offline / default) before the list is returned without them, and the
// overall limit for the whole discovery process.
const PRINTER_DETAILS_WAIT_MS = 8000;
const LIST_PRINTERS_TIMEOUT_MS = 30000;

// Printer NAMES come from .NET's PrinterSettings.InstalledPrinters - Win32
// EnumPrinters level 4, which Microsoft documents as the fast call that
// reads the local printers and the user's printer connections WITHOUT
// contacting any remote print server. The old discovery used only the WMI
// Win32_Printer class, which asks the spooler for each printer's full
// status, including every shared-printer connection on another PC - one
// unreachable or half-deleted connection can stall it past the timeout, and
// then nothing was listed at all.
//
// Win32_Printer is still asked, but only for the optional offline/default
// flags, on its own runspace with a fixed wait: if it is slow or fails, the
// names are still returned, with a warning. Any printer it knows that the
// fast list somehow missed is added too.
const LIST_PRINTERS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$warnings = New-Object System.Collections.Generic.List[string]
$names = New-Object System.Collections.Generic.List[string]
$namesOk = $false
try {
  Add-Type -AssemblyName System.Drawing
  foreach ($n in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) { $names.Add([string]$n) }
  $namesOk = $true
} catch {
  $warnings.Add('Printer names (InstalledPrinters): ' + $_.Exception.Message)
}
$details = @{}
$detailsState = 'ok'
try {
  $ps = [PowerShell]::Create()
  [void]$ps.AddScript({ Get-CimInstance -ClassName Win32_Printer -Property Name, Default, WorkOffline | Select-Object Name, Default, WorkOffline })
  $handle = $ps.BeginInvoke()
  if ($handle.AsyncWaitHandle.WaitOne(__DETAILS_WAIT_MS__)) {
    foreach ($p in $ps.EndInvoke($handle)) { if ($p -and $p.Name) { $details[[string]$p.Name] = $p } }
    if ($ps.Streams.Error.Count -gt 0) { $warnings.Add('Printer details (Win32_Printer): ' + $ps.Streams.Error[0].ToString()) }
  } else {
    $detailsState = 'timeout'
    $warnings.Add('Printer details (Win32_Printer) did not answer within __DETAILS_WAIT_S__s - offline/default flags are not shown.')
  }
} catch {
  $detailsState = 'failed'
  $warnings.Add('Printer details (Win32_Printer): ' + $_.Exception.Message)
}
foreach ($k in $details.Keys) { if (-not $names.Contains($k)) { $names.Add($k) } }
$printers = New-Object System.Collections.Generic.List[object]
foreach ($n in $names) {
  $d = $details[$n]
  $printers.Add([ordered]@{ name = $n; isDefault = [bool]($d -and $d.Default); isOffline = [bool]($d -and $d.WorkOffline) })
}
$result = [ordered]@{ printers = $printers.ToArray(); details = $detailsState; namesOk = $namesOk; warnings = $warnings.ToArray() }
# UTF-8 (no BOM), not the console's OEM code page - so a printer name with
# accented or other non-ASCII characters reaches Node exactly as Windows has it.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
[Console]::Out.Flush()
[Environment]::Exit(0)
`
  .replace(/__DETAILS_WAIT_MS__/g, String(PRINTER_DETAILS_WAIT_MS))
  .replace(/__DETAILS_WAIT_S__/g, String(PRINTER_DETAILS_WAIT_MS / 1000));

// Parses the discovery script's JSON. Also accepts the old Win32_Printer
// shape ({ Name, Default, WorkOffline }, bare object or array) so either
// form reads the same. Names are kept exactly as Windows reports them -
// spaces, punctuation, "\\server\share" connections and all.
//
// `complete` is false when the main name list (InstalledPrinters) could not
// be read, so what was listed may be missing printers that do exist - the
// window then never calls a saved printer "not found" from it, and saving
// does not refuse a printer because it is absent from it.
function parsePrinterList(stdout) {
  const text = (stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { printers: [], warnings: [], details: 'ok', complete: true };
  const parsed = parseJsonOutput(text, 'Printer discovery');
  const isEnvelope = parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'printers' in parsed;
  const raw = isEnvelope ? parsed.printers : parsed;
  // ConvertTo-Json returns a bare object (not a 1-element array) when
  // there's exactly one result — normalize that here so callers never see
  // the difference.
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const printers = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' ? p.name : typeof p.Name === 'string' ? p.Name : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    printers.push({ name, isDefault: !!(p.isDefault ?? p.Default), isOffline: !!(p.isOffline ?? p.WorkOffline) });
  }
  const warnings = isEnvelope && parsed.warnings != null ? [].concat(parsed.warnings).map(String) : [];
  return {
    printers,
    warnings,
    details: isEnvelope && parsed.details ? String(parsed.details) : 'ok',
    complete: !(isEnvelope && parsed.namesOk === false)
  };
}

// Returns { supported: false } on any non-Windows platform. On Windows,
// { supported: true, printers: [{ name, isDefault, isOffline }, ...],
//   warnings: [...], details: 'ok'|'timeout'|'failed', method, elapsedMs }.
// Rejects (with err.diagnostics) only when no printer list could be read.
//
// The inline (-EncodedCommand) run is tried first. If it fails for any
// reason other than a timeout (e.g. security software that blocks encoded
// commands), the same script is tried once more the old way, from a
// temporary .ps1 file. A timeout is not retried - the second try would only
// double the wait.
//
// `deps` is for tests only.
async function listPrinters(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') {
    return { supported: false, printers: [] };
  }
  const runInline = deps.runInline || ((script) => runPowerShellCommand(script, { timeoutMs: LIST_PRINTERS_TIMEOUT_MS }));
  const runFile = deps.runFile || ((script) => runPowerShellScript(script, [], { timeoutMs: LIST_PRINTERS_TIMEOUT_MS }));
  const started = Date.now();

  let stdout;
  let method = 'inline';
  try {
    stdout = await runInline(LIST_PRINTERS_SCRIPT);
  } catch (inlineErr) {
    if (inlineErr.diagnostics && inlineErr.diagnostics.timedOut) throw inlineErr;
    method = 'temp-file';
    try {
      stdout = await runFile(LIST_PRINTERS_SCRIPT);
    } catch (fileErr) {
      const error = new Error(`${inlineErr.message} | Retried from a temporary .ps1 file: ${fileErr.message}`);
      error.diagnostics = { inline: inlineErr.diagnostics || null, tempFile: fileErr.diagnostics || null };
      throw error;
    }
  }

  const parsed = parsePrinterList(stdout);
  return { supported: true, ...parsed, method, elapsedMs: Date.now() - started };
}

const GET_STATUS_SCRIPT = `
param([Parameter(Mandatory=$true)][string]$PrinterName)
$ErrorActionPreference = 'Stop'
$escaped = $PrinterName.Replace("'", "''")
$printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escaped'"
if ($null -eq $printer) {
  @{ found = $false } | ConvertTo-Json -Compress
} else {
  @{ found = $true; isOffline = [bool]$printer.WorkOffline; printerStatus = [int]$printer.PrinterStatus; extendedStatus = [int]$printer.ExtendedPrinterStatus } | ConvertTo-Json -Compress
}
`;

// Returns { supported: false, found: false, offline: false } off-Windows.
// On Windows, { supported: true, found, offline, statusOffline }.
//
// `offline` is the "Use Printer Offline" flag (WorkOffline), exactly as
// before - existing printing checks only that. `statusOffline` is additional:
// Windows' own PrinterStatus/ExtendedPrinterStatus reporting 7 (Offline),
// which is what Windows usually shows for an unplugged or switched-off USB
// printer even when WorkOffline is false. Only Temporary Data Matrix
// Printing refuses to print on it (see main.js's checkTempLabelPrinter).
async function getPrinterStatus(printerName) {
  if (!IS_WINDOWS) {
    return { supported: false, found: false, offline: false };
  }
  if (!printerName) {
    return { supported: true, found: false, offline: false };
  }

  const stdout = await runPowerShellScript(GET_STATUS_SCRIPT, ['-PrinterName', printerName]);
  const parsed = stdout ? JSON.parse(stdout) : { found: false };
  const statusOffline = parsed.printerStatus === 7 || parsed.extendedStatus === 7;
  return { supported: true, found: !!parsed.found, offline: !!parsed.isOffline, statusOffline };
}

// ---- Bounded printer check for Temporary Data Matrix Printing ----
//
// getPrinterStatus() above runs one unbounded WMI query
// (Win32_Printer -Filter "Name='...'") under the 15s PowerShell limit. WMI
// builds a Win32_Printer instance by asking the spooler - and the printer's
// own driver - for its full state; a driver or port that is slow to answer
// (a bidirectional status request the printer does not reply to, for
// example) holds that query until PowerShell is killed, even though Windows
// can still print to the queue. It also cannot find a "\\server\share" name
// (the backslashes are not escaped for WQL - "Invalid query").
//
// This check separates the two questions:
//   1. Does a printer with EXACTLY this name exist? - PrinterSettings.
//      InstalledPrinters (EnumPrinters level 4: the spooler's own list, no
//      driver and no remote server involved), the same fast source as
//      printer discovery. The script returns the whole list as JSON and the
//      name is compared HERE, by printer-names.js's matchPrinterName (exact,
//      after removing only output artefacts at the ends of a name), so the
//      comparison is tested and the log can show both sides of it. If the
//      name is not in that list, a Win32_Printer instance found under exactly
//      this name (step 2) still counts as found.
//   2. Is it offline? - Win32_Printer for that ONE printer (a key lookup,
//      not a query over every printer), on its own runspace with a fixed
//      wait. If it does not answer in time, the result says so
//      (details: 'timeout') instead of the whole check failing.
// The name is passed base64-encoded and decoded inside the script, so no
// printer name can change the script's meaning.
const PRINTER_CHECK_DETAILS_WAIT_MS = 4000;
const PRINTER_CHECK_TIMEOUT_MS = 12000;

const PRINTER_CHECK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew()
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__NAME_B64__'))
$warnings = New-Object System.Collections.Generic.List[string]
$names = New-Object System.Collections.Generic.List[string]
$namesOk = $false
try {
  Add-Type -AssemblyName System.Drawing
  foreach ($n in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) { $names.Add([string]$n) }
  $namesOk = $true
} catch {
  $warnings.Add('Printer names (InstalledPrinters): ' + $_.Exception.Message)
}
$namesMs = $sw.ElapsedMilliseconds
$details = 'ok'
$p = $null
try {
  $ps = [PowerShell]::Create()
  [void]$ps.AddScript({
    param($n)
    $key = New-CimInstance -ClassName Win32_Printer -Property @{ DeviceID = $n } -Key DeviceID -ClientOnly
    Get-CimInstance -InputObject $key -ErrorAction Stop | Select-Object WorkOffline, PrinterStatus, ExtendedPrinterStatus
  }).AddArgument($name)
  $handle = $ps.BeginInvoke()
  if ($handle.AsyncWaitHandle.WaitOne(__DETAILS_WAIT_MS__)) {
    try {
      $p = @($ps.EndInvoke($handle)) | Select-Object -First 1
    } catch {
      $inner = $_.Exception
      while ($inner.InnerException) { $inner = $inner.InnerException }
      if ($inner.Message -match 'Not found') { $details = 'not-found' }
      else { $details = 'failed'; $warnings.Add('Printer status (Win32_Printer): ' + $inner.Message) }
    }
    if ($details -eq 'ok' -and $null -eq $p) { $details = 'not-found' }
  } else {
    $details = 'timeout'
    $warnings.Add('Printer status (Win32_Printer) did not answer within __DETAILS_WAIT_S__s.')
  }
} catch {
  $details = 'failed'
  $warnings.Add('Printer status (Win32_Printer): ' + $_.Exception.Message)
}
$result = [ordered]@{
  names = $names.ToArray()
  namesOk = $namesOk
  keyFound = ($null -ne $p)
  details = $details
  isOffline = [bool]($p -and $p.WorkOffline)
  printerStatus = $(if ($p) { [int]$p.PrinterStatus } else { $null })
  extendedStatus = $(if ($p) { [int]$p.ExtendedPrinterStatus } else { $null })
  namesMs = $namesMs
  detailsMs = $sw.ElapsedMilliseconds - $namesMs
  warnings = $warnings.ToArray()
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 3))
[Console]::Out.Flush()
[Environment]::Exit(0)
`
  .replace(/__DETAILS_WAIT_MS__/g, String(PRINTER_CHECK_DETAILS_WAIT_MS))
  .replace(/__DETAILS_WAIT_S__/g, String(PRINTER_CHECK_DETAILS_WAIT_MS / 1000));

function buildPrinterCheckScript(printerName) {
  return PRINTER_CHECK_SCRIPT.replace('__NAME_B64__', Buffer.from(String(printerName), 'utf8').toString('base64'));
}

// Returns { supported: false, ... } off-Windows. On Windows:
//   { supported: true, found, foundBy, details: 'ok'|'not-found'|'timeout'|'failed',
//     offline, statusOffline, printerStatus, extendedStatus, warnings,
//     namesMs, detailsMs, elapsedMs,
//     requested, installedNames, namesOk, nameMatch, keyFound }
// (`installedNames`/`nameMatch` are what describePrinterNameCheck logs.)
// `offline`/`statusOffline` mean the same as in getPrinterStatus(), and are
// only meaningful when details === 'ok'. Rejects (with err.diagnostics) only
// when PowerShell itself fails or exceeds PRINTER_CHECK_TIMEOUT_MS.
// `deps` is for tests only.
async function checkPrinterForPrinting(printerName, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') {
    return { supported: false, found: false, offline: false, statusOffline: false, details: 'failed', warnings: [] };
  }
  if (!printerName) {
    return { supported: true, found: false, offline: false, statusOffline: false, details: 'not-found', warnings: [] };
  }
  const run = deps.run || ((script) => runPowerShellCommand(script, { timeoutMs: PRINTER_CHECK_TIMEOUT_MS }));
  const started = Date.now();
  const stdout = await run(buildPrinterCheckScript(printerName));
  const parsed = parseJsonOutput(stdout, 'Printer check');
  const details = ['ok', 'not-found', 'timeout', 'failed'].includes(parsed.details) ? parsed.details : 'failed';

  // Current script: the names Windows listed, compared here. (An older
  // script shape that compared inside PowerShell - `found`/`foundBy` - is
  // still read the same way.)
  let found;
  let foundBy;
  let installedNames = null;
  let nameMatch = null;
  const keyFound = parsed.keyFound === true;
  if (Array.isArray(parsed.names) || typeof parsed.names === 'string') {
    installedNames = [].concat(parsed.names).map(String);
    nameMatch = matchPrinterName(printerName, installedNames);
    found = nameMatch.found || keyFound;
    foundBy = nameMatch.found ? 'InstalledPrinters' : keyFound ? 'Win32_Printer' : null;
  } else {
    found = !!parsed.found;
    foundBy = parsed.foundBy || null;
  }
  return {
    supported: true,
    found,
    foundBy,
    requested: printerName,
    installedNames,
    namesOk: parsed.namesOk !== false,
    nameMatch,
    keyFound,
    details,
    offline: details === 'ok' && !!parsed.isOffline,
    statusOffline: details === 'ok' && (parsed.printerStatus === 7 || parsed.extendedStatus === 7),
    printerStatus: parsed.printerStatus ?? null,
    extendedStatus: parsed.extendedStatus ?? null,
    warnings: parsed.warnings == null ? [] : [].concat(parsed.warnings).map(String),
    namesMs: parsed.namesMs ?? null,
    detailsMs: parsed.detailsMs ?? null,
    elapsedMs: Date.now() - started
  };
}

// Canonical Win32 "send raw bytes to a printer queue" pattern (OpenPrinter/
// StartDocPrinter/StartPagePrinter/WritePrinter/EndPagePrinter/EndDocPrinter
// with datatype "RAW") — this is the long-established technique real
// label/receipt-printing software uses on Windows to bypass driver
// rendering entirely, ported here to a PowerShell inline C# type via
// Add-Type rather than a compiled native Node addon.
const SEND_RAW_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string]$DocName = 'Door Tracker Delivery Label'
)
$ErrorActionPreference = 'Stop'
# Progress lines ("STAGE <step> <ms since powershell.exe started>ms") are
# flushed as each step finishes, so if this is ever stopped part-way the
# output captured so far shows the last step that completed.
$launchedAt = [System.Diagnostics.Process]::GetCurrentProcess().StartTime
[Console]::Out.WriteLine('STAGE powershell-ready ' + [long]((Get-Date) - $launchedAt).TotalMilliseconds + 'ms')
[Console]::Out.Flush()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void Mark(string stage)
    {
        double ms = (DateTime.Now - System.Diagnostics.Process.GetCurrentProcess().StartTime).TotalMilliseconds;
        Console.Out.WriteLine("STAGE " + stage + " " + ((long)ms).ToString() + "ms");
        Console.Out.Flush();
    }

    public static void SendBytesToPrinter(string printerName, byte[] bytes, string docName)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = docName;
        di.pDataType = "RAW";
        bool ok;

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
        }
        Mark("open-printer");
        try
        {
            if (!StartDocPrinter(hPrinter, 1, di))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
            }
            Mark("start-doc");
            try
            {
                if (!StartPagePrinter(hPrinter))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
                }
                IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                    int written;
                    ok = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out written);
                    if (!ok || written != bytes.Length)
                    {
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed or wrote a short buffer");
                    }
                    Mark("write-printer " + written.ToString() + "-bytes");
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
            }
            finally
            {
                EndDocPrinter(hPrinter);
                Mark("end-doc");
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
'@

[RawPrinterHelper]::Mark('compiled')
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes, $DocName)
Write-Output "OK"
`;

// The name Windows shows for a job in the printer queue. Every existing
// caller (delivery/main-printer jobs, the test pattern) passes nothing and
// keeps exactly this name; Temporary Data Matrix Printing passes its own.
const DEFAULT_DOC_NAME = 'Door Tracker Delivery Label';

// A document name is shown, never interpreted: keep it short, printable
// ASCII (DOCINFOA is ANSI), and fall back to the default if nothing is left.
function cleanDocName(docName) {
  if (typeof docName !== 'string') return DEFAULT_DOC_NAME;
  const cleaned = docName.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 100);
  return cleaned || DEFAULT_DOC_NAME;
}

// Submits raw bytes (already-generated ZPL text, encoded as a Buffer) to a
// named Windows printer queue, bypassing the driver's own rendering.
// options.docName (optional) is the job name shown in the Windows queue.
// Resolves once Windows has accepted the submission (WritePrinter
// succeeded) — see printer-service.js for exactly what that does and does
// not prove about physical output.
//
// Resolves with { elapsedMs, stages } - stages are the script's progress
// lines ("powershell-ready 650ms", "compiled 900ms", "open-printer ...",
// "start-doc ...", "write-printer 312-bytes ...", "end-doc ...", times since
// powershell.exe started). Existing callers ignore the value. On failure the
// same lines are on err.diagnostics.stages, so a timeout shows the last step
// that finished.
function parseSendStages(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('STAGE '))
    .map((line) => line.slice(6));
}

async function sendRawData(printerName, dataBuffer, options = {}) {
  if (!IS_WINDOWS) {
    throw new Error('Raw printer submission is only implemented on Windows.');
  }

  const tempDataPath = path.join(os.tmpdir(), `combridge-print-${randomUUID()}.zpl`);
  fs.writeFileSync(tempDataPath, dataBuffer);

  const started = Date.now();
  try {
    const stdout = await runPowerShellScript(SEND_RAW_SCRIPT, ['-PrinterName', printerName, '-FilePath', tempDataPath, '-DocName', cleanDocName(options && options.docName)]);
    return { elapsedMs: Date.now() - started, stages: parseSendStages(stdout) };
  } catch (err) {
    if (err && err.diagnostics) err.diagnostics.stages = parseSendStages(err.diagnostics.stdout);
    throw err;
  } finally {
    fs.unlink(tempDataPath, () => {});
  }
}

module.exports = {
  listPrinters,
  getPrinterStatus,
  checkPrinterForPrinting,
  sendRawData,
  cleanDocName,
  DEFAULT_DOC_NAME,
  // Exposed for tests and diagnostics.
  parsePrinterList,
  parseSendStages,
  buildPrinterCheckScript,
  PRINTER_CHECK_DETAILS_WAIT_MS,
  PRINTER_CHECK_TIMEOUT_MS,
  describePowerShellFailure,
  decodeClixml,
  runPowerShellCommand,
  LIST_PRINTERS_SCRIPT,
  LIST_PRINTERS_TIMEOUT_MS
};
