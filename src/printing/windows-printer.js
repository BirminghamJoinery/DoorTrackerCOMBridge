// Windows-only printer access: enumerate installed printers, check whether
// a specific one exists/is online, and submit raw bytes to a named printer
// queue. Every exported function checks process.platform itself and
// returns a clear "not supported here" result on any other platform —
// nothing in this file ever throws just because it's running on macOS
// during development; it simply reports that it can't do anything real.
//
// No native Node dependency is used for any of this — each operation
// shells out to Windows' own PowerShell (present on every Windows install)
// via a small script, run once: printer DISCOVERY passes its script inline
// (-EncodedCommand, see listPrinters), the printing operations write it to
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
try {
  Add-Type -AssemblyName System.Drawing
  foreach ($n in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) { $names.Add([string]$n) }
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
$result = [ordered]@{ printers = $printers.ToArray(); details = $detailsState; warnings = $warnings.ToArray() }
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
function parsePrinterList(stdout) {
  const text = (stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { printers: [], warnings: [], details: 'ok' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Printer discovery returned output that is not JSON: ${clip(text, 300)}`);
  }
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
  return { printers, warnings, details: isEnvelope && parsed.details ? String(parsed.details) : 'ok' };
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
        try
        {
            if (!StartDocPrinter(hPrinter, 1, di))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
            }
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
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
'@

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
async function sendRawData(printerName, dataBuffer, options = {}) {
  if (!IS_WINDOWS) {
    throw new Error('Raw printer submission is only implemented on Windows.');
  }

  const tempDataPath = path.join(os.tmpdir(), `combridge-print-${randomUUID()}.zpl`);
  fs.writeFileSync(tempDataPath, dataBuffer);

  try {
    await runPowerShellScript(SEND_RAW_SCRIPT, ['-PrinterName', printerName, '-FilePath', tempDataPath, '-DocName', cleanDocName(options && options.docName)]);
  } finally {
    fs.unlink(tempDataPath, () => {});
  }
}

module.exports = {
  listPrinters,
  getPrinterStatus,
  sendRawData,
  cleanDocName,
  DEFAULT_DOC_NAME,
  // Exposed for tests and diagnostics.
  parsePrinterList,
  describePowerShellFailure,
  decodeClixml,
  runPowerShellCommand,
  LIST_PRINTERS_SCRIPT,
  LIST_PRINTERS_TIMEOUT_MS
};
