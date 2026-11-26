// Windows printer discovery (listPrinters) - parsing, error reporting and the
// inline -> temporary-file fallback, plus two real-PowerShell checks that run
// only on Windows. The printing functions (sendRawData, getPrinterStatus) are
// not exercised here - their behaviour is unchanged.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const windowsPrinter = require('./windows-printer');
const {
  listPrinters,
  parsePrinterList,
  describePowerShellFailure,
  decodeClixml,
  runPowerShellCommand,
  LIST_PRINTERS_SCRIPT
} = windowsPrinter;

const IS_WINDOWS = process.platform === 'win32';

// Real Windows printer names seen in the field, plus deliberately awkward
// ones: spaces, brackets, '#', quotes, '&', a "\\server\share" connection,
// PowerShell-special characters and non-ASCII.
const AWKWARD_NAMES = [
  'ZDesigner GK420d',
  'TSC TE210 #2',
  'TOSHIBA B-FV4 (203 dpi)',
  'SHARP MX-4060N (7800736500)',
  '\\\\DESKTOP-5OHKE65.bjltd.local\\TOSHIBA B-FV4 (203 dpi)',
  'O\'Brien "Label" & Co, #3',
  'semi;colon [brackets] {braces} $dollar `tick',
  'Étiquette – Zebra ü'
];

function fakeExecError({ code = 1, killed = false, signal = null, message = 'Command failed: powershell.exe ...' } = {}) {
  const err = new Error(message);
  err.code = code;
  err.killed = killed;
  err.signal = signal;
  return err;
}

// ---- parsePrinterList ----

test('parses the discovery envelope, keeping every awkward printer name exactly', () => {
  const stdout = JSON.stringify({
    printers: AWKWARD_NAMES.map((name, i) => ({ name, isDefault: i === 1, isOffline: i === 0 })),
    details: 'ok',
    warnings: []
  });
  const parsed = parsePrinterList(stdout);
  assert.deepEqual(parsed.printers.map((p) => p.name), AWKWARD_NAMES);
  assert.equal(parsed.printers[0].isOffline, true);
  assert.equal(parsed.printers[1].isDefault, true);
  assert.equal(parsed.printers[2].isDefault, false);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.details, 'ok');
});

test('a single printer serialised as a bare object (ConvertTo-Json) still reads as a list', () => {
  const envelope = parsePrinterList('{"printers":{"name":"TSC TE210","isDefault":false,"isOffline":true},"details":"ok","warnings":[]}');
  assert.deepEqual(envelope.printers, [{ name: 'TSC TE210', isDefault: false, isOffline: true }]);
  // The old Win32_Printer shape, bare object and array.
  assert.deepEqual(parsePrinterList('{"Name":"ZDesigner GK420d","Default":true,"WorkOffline":false}').printers, [
    { name: 'ZDesigner GK420d', isDefault: true, isOffline: false }
  ]);
  assert.equal(parsePrinterList('[{"Name":"A"},{"Name":"B b (1)"}]').printers.length, 2);
});

test('zero printers, empty output and a UTF-8 BOM all parse cleanly', () => {
  assert.deepEqual(parsePrinterList('{"printers":[],"details":"ok","warnings":[]}').printers, []);
  assert.deepEqual(parsePrinterList('').printers, []);
  assert.deepEqual(parsePrinterList('\uFEFF{"printers":[{"name":"X"}]}').printers.map((p) => p.name), ['X']);
});

test('duplicate and nameless entries are dropped; warnings and the details state are kept', () => {
  const parsed = parsePrinterList(JSON.stringify({
    printers: [{ name: 'A' }, { name: 'A' }, { name: '' }, null, { isDefault: true }],
    details: 'timeout',
    warnings: 'Printer details (Win32_Printer) did not answer within 8s'
  }));
  assert.deepEqual(parsed.printers.map((p) => p.name), ['A']);
  assert.equal(parsed.details, 'timeout');
  assert.deepEqual(parsed.warnings, ['Printer details (Win32_Printer) did not answer within 8s']);
});

test('output that is not JSON is a clear error quoting what came back', () => {
  assert.throws(() => parsePrinterList('Get-CimInstance : Access denied'), /not JSON: Get-CimInstance : Access denied/);
});

test('a list whose main name source (InstalledPrinters) failed is marked incomplete', () => {
  assert.equal(parsePrinterList('{"printers":[{"name":"TOSHIBA B-FV4 (203 dpi)"}],"details":"ok","namesOk":true,"warnings":[]}').complete, true);
  const partial = parsePrinterList('{"printers":[],"details":"timeout","namesOk":false,"warnings":["Printer names (InstalledPrinters): RPC server unavailable"]}');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.printers, []);
  assert.equal(parsePrinterList('[{"Name":"A"}]').complete, true, 'older shapes are read as before');
  assert.equal(parsePrinterList('\r\n{"printers":[{"name":"TOSHIBA B-FV4 (203 dpi)"}],"namesOk":true}\r\n').printers[0].name, 'TOSHIBA B-FV4 (203 dpi)');
});

// ---- describePowerShellFailure ----

test('a timeout says so - not just "Command failed"', () => {
  const err = describePowerShellFailure({
    err: fakeExecError({ code: null, killed: true, signal: 'SIGTERM' }),
    stdout: '',
    stderr: '',
    timeoutMs: 30000,
    command: 'powershell.exe ... -EncodedCommand <inline>',
    elapsedMs: 30012
  });
  assert.match(err.message, /PowerShell did not finish within 30s and was stopped/);
  assert.doesNotMatch(err.message, /Command failed/);
  assert.equal(err.diagnostics.timedOut, true);
  assert.equal(err.diagnostics.signal, 'SIGTERM');
  assert.equal(err.diagnostics.elapsedMs, 30012);
});

test('a non-zero exit surfaces the exit code and PowerShell\'s own stderr', () => {
  const err = describePowerShellFailure({
    err: fakeExecError({ code: 1 }),
    stdout: 'partial',
    stderr: 'Get-CimInstance : Access denied\r\nAt line:1 char:1\r\n',
    timeoutMs: 15000
  });
  assert.match(err.message, /^PowerShell exited with code 1: Get-CimInstance : Access denied/);
  assert.equal(err.diagnostics.exitCode, 1);
  assert.equal(err.diagnostics.stdout, 'partial');
  assert.match(err.diagnostics.stderr, /Access denied/);
});

test('a non-zero exit with nothing on stderr says so explicitly', () => {
  const err = describePowerShellFailure({ err: fakeExecError({ code: -196608 }), stdout: '', stderr: '', timeoutMs: 15000 });
  assert.equal(err.message, 'PowerShell exited with code -196608: (no error output)');
});

test('powershell.exe missing is reported plainly', () => {
  const err = describePowerShellFailure({ err: fakeExecError({ code: 'ENOENT' }), stdout: '', stderr: '', timeoutMs: 15000 });
  assert.match(err.message, /powershell\.exe could not be found/);
});

test('CLIXML on stderr (Windows PowerShell 5.1) is decoded to readable text', () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Access is denied &amp; blocked_x000D__x000A_</S><S S="Error">At line:1_x000D__x000A_</S></Objs>';
  assert.equal(decodeClixml(clixml), 'Access is denied & blocked\r\nAt line:1');
  const err = describePowerShellFailure({ err: fakeExecError({ code: 1 }), stdout: '', stderr: clixml, timeoutMs: 15000 });
  assert.match(err.message, /PowerShell exited with code 1: Access is denied & blocked/);
  assert.equal(decodeClixml('plain text'), 'plain text');
});

// ---- runPowerShellCommand (inline, no temp file) ----

test('discovery runs inline with -EncodedCommand - no temporary .ps1, script decodes back exactly', async () => {
  let seen;
  const fakeExecFile = (file, args, options, callback) => {
    seen = { file, args, options };
    callback(null, '{"printers":[]}\r\n', '');
  };
  const out = await runPowerShellCommand(LIST_PRINTERS_SCRIPT, { timeoutMs: 1234, execFileImpl: fakeExecFile });
  assert.equal(out, '{"printers":[]}');
  assert.equal(seen.file, 'powershell.exe');
  assert.ok(!seen.args.includes('-File'), 'no -File');
  const i = seen.args.indexOf('-EncodedCommand');
  assert.ok(i > 0);
  assert.equal(Buffer.from(seen.args[i + 1], 'base64').toString('utf16le'), LIST_PRINTERS_SCRIPT);
  assert.ok(seen.args.includes('-NoProfile') && seen.args.includes('-NonInteractive'));
  assert.equal(seen.options.timeout, 1234);
  assert.equal(seen.options.windowsHide, true);
  // Well inside Windows' 32,767-character command-line limit.
  assert.ok(seen.args.join(' ').length < 30000);
});

test('an inline failure rejects with the useful stderr and the command (not the script) in diagnostics', async () => {
  const fakeExecFile = (file, args, options, callback) => callback(fakeExecError({ code: 1 }), '', 'This script contains malicious content and has been blocked by your antivirus software.');
  await assert.rejects(runPowerShellCommand('Write-Output 1', { execFileImpl: fakeExecFile }), (err) => {
    assert.match(err.message, /exited with code 1: This script contains malicious content/);
    assert.match(err.diagnostics.command, /-EncodedCommand <inline script, \d+ chars>/);
    return true;
  });
});

// ---- listPrinters: fallback chain ----

const timeoutError = () => {
  const err = new Error('PowerShell did not finish within 30s and was stopped');
  err.diagnostics = { timedOut: true };
  return err;
};

test('off Windows: not supported, never runs PowerShell', async () => {
  const result = await listPrinters({
    platform: 'darwin',
    runInline: () => assert.fail('must not run'),
    runFile: () => assert.fail('must not run')
  });
  assert.deepEqual(result, { supported: false, printers: [] });
});

test('inline success: the temporary-file path is never used', async () => {
  const result = await listPrinters({
    platform: 'win32',
    runInline: async () => JSON.stringify({ printers: [{ name: 'TSC TE210 #2' }], details: 'ok', warnings: [] }),
    runFile: () => assert.fail('must not fall back')
  });
  assert.equal(result.supported, true);
  assert.equal(result.method, 'inline');
  assert.deepEqual(result.printers, [{ name: 'TSC TE210 #2', isDefault: false, isOffline: false }]);
});

test('inline blocked (not a timeout): falls back to the temporary .ps1 once and succeeds', async () => {
  let fileRuns = 0;
  const result = await listPrinters({
    platform: 'win32',
    runInline: async () => { throw Object.assign(new Error('PowerShell exited with code 1: blocked'), { diagnostics: { timedOut: false } }); },
    runFile: async () => { fileRuns += 1; return '{"printers":[{"name":"A"},{"name":"B"}]}'; }
  });
  assert.equal(fileRuns, 1);
  assert.equal(result.method, 'temp-file');
  assert.equal(result.printers.length, 2);
});

test('both ways fail: one error carrying both stderr messages and both diagnostics', async () => {
  await assert.rejects(
    listPrinters({
      platform: 'win32',
      runInline: async () => { throw Object.assign(new Error('PowerShell exited with code 1: encoded commands are blocked'), { diagnostics: { exitCode: 1 } }); },
      runFile: async () => { throw Object.assign(new Error('running scripts is disabled on this system'), { diagnostics: { exitCode: 1 } }); }
    }),
    (err) => {
      assert.match(err.message, /encoded commands are blocked/);
      assert.match(err.message, /Retried from a temporary \.ps1 file: running scripts is disabled/);
      assert.deepEqual(err.diagnostics, { inline: { exitCode: 1 }, tempFile: { exitCode: 1 } });
      return true;
    }
  );
});

test('a timeout is not retried (that would only double the wait)', async () => {
  await assert.rejects(
    listPrinters({ platform: 'win32', runInline: async () => { throw timeoutError(); }, runFile: () => assert.fail('must not retry') }),
    /did not finish within 30s/
  );
});

test('the discovery script lists names without WMI and bounds the optional WMI details', () => {
  assert.match(LIST_PRINTERS_SCRIPT, /\[System\.Drawing\.Printing\.PrinterSettings\]::InstalledPrinters/);
  assert.match(LIST_PRINTERS_SCRIPT, /AsyncWaitHandle\.WaitOne\(8000\)/);
  assert.match(LIST_PRINTERS_SCRIPT, /UTF8Encoding \$false/);
  assert.doesNotMatch(LIST_PRINTERS_SCRIPT, /__DETAILS_WAIT/);
});

// ---- Real PowerShell (Windows only) ----

test('Windows: real discovery returns this PC\'s printers inline', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async () => {
  const result = await listPrinters();
  assert.equal(result.supported, true);
  assert.equal(result.method, 'inline', `fell back: ${JSON.stringify(result.warnings)}`);
  assert.ok(Array.isArray(result.printers));
  for (const p of result.printers) {
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.length > 0);
  }
  assert.ok(['ok', 'timeout', 'failed'].includes(result.details));
});

test('Windows: awkward and non-ASCII printer names survive the real PowerShell -> JSON -> Node round trip', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async () => {
  // The names go in as base64 UTF-8 so nothing about the test itself depends
  // on quoting; they come back through the same output path the discovery
  // script uses (UTF-8 console encoding + ConvertTo-Json).
  const b64 = Buffer.from(JSON.stringify(AWKWARD_NAMES), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$names = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json
$printers = @(); foreach ($n in $names) { $printers += [ordered]@{ name = [string]$n; isDefault = $false; isOffline = $false } }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write(([ordered]@{ printers = $printers; details = 'ok'; warnings = @() } | ConvertTo-Json -Compress -Depth 4))
`;
  const stdout = await runPowerShellCommand(script, { timeoutMs: 45000 });
  assert.deepEqual(parsePrinterList(stdout).printers.map((p) => p.name), AWKWARD_NAMES);
});

test('Windows: a real PowerShell failure surfaces its stderr and exit code', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async () => {
  await assert.rejects(
    runPowerShellCommand("[Console]::Error.WriteLine('printer spooler unavailable'); exit 3", { timeoutMs: 45000 }),
    (err) => {
      assert.match(err.message, /PowerShell exited with code 3: printer spooler unavailable/);
      assert.equal(err.diagnostics.exitCode, 3);
      return true;
    }
  );
});

test('Windows: a real timeout is reported as a timeout', { skip: !IS_WINDOWS && 'Windows only', timeout: 60000 }, async () => {
  await assert.rejects(runPowerShellCommand('Start-Sleep -Seconds 30', { timeoutMs: 1500 }), (err) => {
    assert.match(err.message, /did not finish within 2s and was stopped/);
    assert.equal(err.diagnostics.timedOut, true);
    return true;
  });
});
