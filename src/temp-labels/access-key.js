// The key this PC uses to read GET /api/temp-labels from the website.
//
// Same scheme as the website's Photo Bridge endpoints: the bridge sends
// "Authorization: Bearer <key>", and the website stores only the key's
// SHA-256 (TEMP_LABELS_KEY_SHA256), compared in constant time. The key is
// generated HERE - 32 random bytes - so nobody ever has to type, copy or
// paste the secret itself: the app shows only its SHA-256, which is what
// goes into the website's environment.
//
// Stored as temp-labels-access-key.json in userData, the key encrypted with
// the injected encrypt/decrypt (Electron safeStorage = Windows DPAPI, tied to
// this Windows user). The key is never logged, never sent to the renderer,
// and never written anywhere in plain text.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');

const FILE_VERSION = 1;
const KEY_BYTES = 32;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// deps:
//   filePath                 - temp-labels-access-key.json
//   isEncryptionAvailable()  -> boolean
//   encrypt(text)            -> Buffer
//   decrypt(Buffer)          -> text
//   randomBytes(n)           -> Buffer (tests)
//   now()                    -> Date (tests)
function createAccessKeyStore({ filePath, isEncryptionAvailable, encrypt, decrypt, randomBytes = crypto.randomBytes, now = () => new Date() }) {
  function readFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.version !== FILE_VERSION || typeof parsed.encrypted !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.sha256 || '')) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // The key itself, or null (none set, or it cannot be decrypted - e.g. the
  // file was copied from another PC or Windows user). Never throws.
  function getKey() {
    const record = readFile();
    if (!record) return null;
    try {
      if (!isEncryptionAvailable()) return null;
      const key = decrypt(Buffer.from(record.encrypted, 'base64'));
      return typeof key === 'string' && sha256Hex(key) === record.sha256 ? key : null;
    } catch {
      return null;
    }
  }

  // What the UI may show - never the key.
  function status() {
    const record = readFile();
    if (!record) return { set: false };
    const usable = getKey() !== null;
    return {
      set: true,
      usable,
      sha256: record.sha256,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      problem: usable ? null : 'The saved key cannot be read on this PC/Windows user - generate a new one.'
    };
  }

  // Makes a new key (replacing any old one) and returns its SHA-256.
  function generate() {
    if (!isEncryptionAvailable()) return { ok: false, error: 'Windows secure storage is not available, so the key cannot be stored safely.' };
    const key = randomBytes(KEY_BYTES).toString('base64url');
    const record = {
      version: FILE_VERSION,
      encrypted: encrypt(key).toString('base64'),
      sha256: sha256Hex(key),
      createdAt: now().toISOString()
    };
    fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temp, filePath);
    return { ok: true, sha256: record.sha256, createdAt: record.createdAt };
  }

  return { getKey, status, generate };
}

module.exports = { KEY_BYTES, sha256Hex, createAccessKeyStore };
