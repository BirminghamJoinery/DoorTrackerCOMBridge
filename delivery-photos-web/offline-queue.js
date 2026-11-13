// The iPad's own offline queue: photo sessions (Delivery, Bench or
// Ironmongery - see photo-roles.js) that could not be
// sent to the Windows Photo Service at the time (the iPad was away from the
// workshop Wi-Fi, the PC was off, pairing had been reset...) are kept here,
// in this site's own IndexedDB, until they can be.
//
// Like reference.js, this one file works unchanged in the browser (a plain
// <script>, exposing window.DeliveryOfflineQueue) and in Node (require()) -
// the automated tests drive exactly this code, with a fake IndexedDB and a
// fake or real Photo Service behind the injected `api`.
//
// Rules this file enforces:
//   - A session is only reported as "saved on this iPad" once every photo
//     has been written AND read back with a matching size and SHA-256.
//   - A queued photo is the exact same JPEG bytes that would have been
//     uploaded straight away - never re-encoded or resized.
//   - The session is only removed from this iPad once every photo has come
//     back 201 (saved and read back off the company drive by the PC) AND the
//     PC has acknowledged the session-complete report. Nothing is deleted on
//     a failure, a lost connection, or a pairing problem.
//   - Records hold only session metadata and photographs: never the pairing
//     token, network paths, file names, or any credential.
//   - A session remembers the role it was taken as. It is only ever sent by
//     an iPad still paired as that role - and the PC checks the role against
//     the pairing token regardless, so editing a queued record can never
//     turn one kind of photo into another.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeliveryOfflineQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DB_NAME = 'delivery-photos-offline';
  const DB_VERSION = 1;
  const SESSIONS = 'sessions';
  const PHOTOS = 'photos';

  // Session status values, as stored.
  const STATUS = {
    PENDING: 'pending', // waiting to send (also what an interrupted 'syncing' is treated as)
    SYNCING: 'syncing', // a send attempt is in progress (or was, when the page was closed)
    FAILED: 'failed', // the last attempt reached the PC but did not fully succeed
    NEEDS_PAIRING: 'needs_pairing', // the PC rejected this iPad's pairing token
    WRONG_ROLE: 'wrong_role' // taken as one role, but this iPad is now paired as another
  };

  // Sessions queued before photo roles existed carry no role or code: they
  // are Delivery sessions, and their delivery reference is the scanned code.
  function sessionRole(session) {
    return session.role || 'delivery';
  }

  function sessionCode(session) {
    return session.code || session.reference;
  }

  // Above this fraction of the browser's own quota, the person is warned.
  const HIGH_USAGE_FRACTION = 0.8;
  // Room kept spare on top of a new session's own photo bytes when deciding
  // whether it fits (IndexedDB bookkeeping, plus not running the origin's
  // storage right up to the edge, where Safari starts refusing writes).
  const SAFETY_MARGIN_FRACTION = 0.1;
  const SAFETY_MARGIN_MIN_BYTES = 20 * 1000 * 1000;

  // ---- helpers ------------------------------------------------------------

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Resolves only once the transaction has COMMITTED - not merely once its
  // requests succeeded - so "saved" really means durable.
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('The save was aborted.'));
      tx.onerror = () => reject(tx.error || new Error('The save failed.'));
    });
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // The same Full/Part mapping the Windows app's tracking.js uses for the
  // Google Sheet, from reference.js's parsed result.
  function deliveryMetadata(parsed) {
    return {
      role: 'delivery',
      code: parsed.reference,
      baseOrder: parsed.orderNumber,
      reference: parsed.reference,
      orderNumber: parsed.orderNumber,
      deliveryType: parsed.type === 'part' ? 'Part Delivery' : 'Full Delivery',
      partNo: parsed.type === 'part' ? parsed.partNumber : ''
    };
  }

  // Everything a queued session needs to remember from its scan, from
  // photo-roles.js's parseForRole() result: the role, the original scanned
  // value, the base order, and - for a Delivery - its Full/Part details.
  function sessionMetadata(parsed) {
    if (parsed.role === 'delivery') return deliveryMetadata(parsed.delivery);
    return { role: parsed.role, code: parsed.code, baseOrder: parsed.baseOrder, reference: '', orderNumber: parsed.baseOrder, deliveryType: '', partNo: '' };
  }

  // ---- storage --------------------------------------------------------------

  // Opens (creating on first use) this origin's offline queue database.
  // `indexedDB` is injected so tests can supply a fake one.
  function openStore({ indexedDB, name = DB_NAME } = {}) {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains(PHOTOS)) {
        const photos = db.createObjectStore(PHOTOS, { keyPath: 'photoId' });
        photos.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    return requestToPromise(request).then((db) => createStore(db));
  }

  function createStore(db) {
    // Strictly increasing, even for two sessions saved within the same
    // millisecond, so "oldest first" is always well defined.
    let lastQueueOrder = 0;

    async function getPhotos(sessionId) {
      const tx = db.transaction(PHOTOS, 'readonly');
      const photos = await requestToPromise(tx.objectStore(PHOTOS).index('sessionId').getAll(sessionId));
      return photos.sort((a, b) => a.position - b.position);
    }

    async function getSession(sessionId) {
      const tx = db.transaction(SESSIONS, 'readonly');
      return (await requestToPromise(tx.objectStore(SESSIONS).get(sessionId))) || null;
    }

    // Writes one whole delivery session - its metadata and every photo - in a
    // SINGLE transaction (all or nothing: a full iPad or a crash can never
    // leave half a session behind), then reads every photo back and checks it.
    // `photos`: [{ photoId, bytes (ArrayBuffer), sha256?, width, height,
    // capturedAt, uploaded? }] in shooting order. A photo already uploaded
    // (the online path got partway, or all the way) needs no bytes at all.
    async function saveSession(session, photos) {
      const now = new Date().toISOString();
      const prepared = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        const uploaded = Boolean(p.uploaded);
        const bytes = uploaded ? null : p.bytes;
        if (!uploaded && !(bytes instanceof ArrayBuffer && bytes.byteLength > 0)) throw new Error('A photograph has no data to save.');
        prepared.push({
          photoId: p.photoId,
          sessionId: session.sessionId,
          position: i,
          bytes,
          sizeBytes: uploaded ? p.sizeBytes || 0 : bytes.byteLength,
          sha256: uploaded ? p.sha256 || '' : p.sha256 || (await sha256Hex(bytes)),
          width: p.width || 0,
          height: p.height || 0,
          capturedAt: p.capturedAt || now,
          uploaded,
          uploadedAt: uploaded ? p.uploadedAt || now : ''
        });
      }

      const record = {
        sessionId: session.sessionId,
        role: sessionRole(session),
        code: sessionCode(session),
        baseOrder: session.baseOrder || session.orderNumber,
        reference: session.reference || '',
        orderNumber: session.orderNumber,
        deliveryType: session.deliveryType,
        partNo: session.partNo,
        photoCount: prepared.length,
        totalBytes: prepared.reduce((sum, p) => sum + (p.bytes ? p.bytes.byteLength : 0), 0),
        capturedAt: session.capturedAt || (prepared[0] && prepared[0].capturedAt) || now,
        createdAt: now,
        queueOrder: (lastQueueOrder = Math.max(Date.now(), lastQueueOrder + 1)),
        status: STATUS.PENDING,
        attempts: 0,
        lastAttemptAt: '',
        lastError: ''
      };

      const tx = db.transaction([SESSIONS, PHOTOS], 'readwrite');
      tx.objectStore(SESSIONS).put(record);
      for (const p of prepared) tx.objectStore(PHOTOS).put(p);
      await transactionDone(tx);

      await verifySession(record.sessionId, prepared);
      return record;
    }

    // Reads every photo of a just-saved session back out of IndexedDB and
    // checks its size and SHA-256 against what was meant to be written. On
    // any mismatch the session is removed again and an error thrown - the
    // caller must then NOT tell the person it was saved.
    async function verifySession(sessionId, expected) {
      const stored = await getPhotos(sessionId);
      const problem = await (async () => {
        if (stored.length !== expected.length) return `expected ${expected.length} photographs, found ${stored.length}`;
        for (let i = 0; i < expected.length; i++) {
          const want = expected[i];
          const got = stored[i];
          if (got.photoId !== want.photoId) return 'photographs out of order';
          if (want.uploaded) continue;
          if (!got.bytes || got.bytes.byteLength !== want.sizeBytes) return `photograph ${i + 1} has the wrong size`;
          if ((await sha256Hex(got.bytes)) !== want.sha256) return `photograph ${i + 1} did not read back correctly`;
        }
        return '';
      })();
      if (problem) {
        await deleteSession(sessionId).catch(() => {});
        throw new Error(`Could not save on this iPad (${problem}).`);
      }
    }

    async function listSessions() {
      const tx = db.transaction(SESSIONS, 'readonly');
      const sessions = await requestToPromise(tx.objectStore(SESSIONS).getAll());
      // Tolerates records missing either field (an older or damaged record
      // must still be listed, never break the whole list).
      return sessions.sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    }

    // Read-modify-write inside ONE transaction, using plain callbacks rather
    // than awaiting between the read and the write: older Safari versions end
    // an IndexedDB transaction early across an await, which would silently
    // drop the write.
    function modifyRecord(storeName, key, change) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) store.put(change(request.result));
      };
      return transactionDone(tx);
    }

    function updateSession(sessionId, patch) {
      return modifyRecord(SESSIONS, sessionId, (current) => ({ ...current, ...patch, sessionId }));
    }

    // Marks one photo as saved on the company drive. Its bytes are KEPT until
    // the whole session is acknowledged (see deleteSession) - nothing is
    // thrown away part-way through a session.
    function markPhotoUploaded(photoId) {
      return modifyRecord(PHOTOS, photoId, (current) => ({ ...current, uploaded: true, uploadedAt: new Date().toISOString() }));
    }

    // Removes one session and ONLY its own photos, in one transaction.
    function deleteSession(sessionId) {
      const tx = db.transaction([SESSIONS, PHOTOS], 'readwrite');
      tx.objectStore(SESSIONS).delete(sessionId);
      const photos = tx.objectStore(PHOTOS);
      const request = photos.index('sessionId').getAllKeys(sessionId);
      request.onsuccess = () => {
        for (const key of request.result) photos.delete(key);
      };
      return transactionDone(tx);
    }

    function close() {
      db.close();
    }

    return { saveSession, verifySession, listSessions, getSession, getPhotos, updateSession, markPhotoUploaded, deleteSession, close };
  }

  // ---- storage space --------------------------------------------------------

  // Turns navigator.storage.estimate()'s { usage, quota } into what the UI
  // and the "is there room for this session?" check need. Every limit here
  // comes from the browser's own reported quota - nothing is an arbitrary
  // fixed size. When the browser cannot report a quota at all, nothing is
  // refused on that basis (the write itself will still fail cleanly, as one
  // transaction, if storage really is full).
  function assessStorage(estimate, neededBytes = 0) {
    const usage = estimate && Number.isFinite(estimate.usage) ? estimate.usage : null;
    const quota = estimate && Number.isFinite(estimate.quota) && estimate.quota > 0 ? estimate.quota : null;
    if (usage === null || quota === null) {
      return { known: false, usedBytes: usage, quotaBytes: quota, availableBytes: null, fraction: null, high: false, canStore: true, reason: '' };
    }
    const availableBytes = Math.max(0, quota - usage);
    const fraction = usage / quota;
    const margin = Math.max(SAFETY_MARGIN_MIN_BYTES, neededBytes * SAFETY_MARGIN_FRACTION);
    const canStore = neededBytes + margin <= availableBytes;
    return {
      known: true,
      usedBytes: usage,
      quotaBytes: quota,
      availableBytes,
      fraction,
      high: fraction >= HIGH_USAGE_FRACTION,
      canStore,
      reason: canStore ? '' : 'There is not enough storage space left on this iPad to save these photographs offline.'
    };
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return 'unknown';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
    return `${bytes} bytes`;
  }

  // ---- sending --------------------------------------------------------------

  // Why a send did not succeed, as one of a small fixed set of kinds - so the
  // Pending screen can say what is actually wrong ("Authentication failed",
  // "Server returned 500") instead of a generic "waiting". Stored on the
  // session as lastErrorKind, beside the server's own message in lastError.
  const FAILURE_LABELS = {
    unreachable: 'Photo Service unreachable',
    timeout: 'Upload timed out',
    auth: 'Authentication failed',
    pairing: 'Pairing required',
    wrong_role: 'Paired for a different kind of photo',
    format: 'Session format invalid',
    drive: 'Network drive unavailable',
    server: 'Server error',
    busy: 'Photo Service busy',
    rejected: 'Refused by the Photo Service',
    not_found: 'Not recognised by the Photo Service',
    storage: 'Could not read this delivery from the iPad',
    internal: 'Unexpected error on the iPad'
  };

  // HTTP status -> kind, for any answer the Photo Service gives.
  function classifyHttpStatus(status) {
    if (status === 401) return 'auth';
    if (status === 403) return 'wrong_role';
    if (status === 404 || status === 405) return 'not_found';
    if (status === 429) return 'busy';
    if (status === 502 || status === 507) return 'drive';
    if (status >= 500) return 'server';
    if (status >= 400) return 'rejected';
    return 'server';
  }

  // A one-line, human reason: "Server returned 500: Something went wrong."
  function failureLabel(kind, status) {
    if (kind === 'server' && status) return `Server returned ${status}`;
    return FAILURE_LABELS[kind] || FAILURE_LABELS.internal;
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;
  const ROLES = ['delivery', 'bench', 'ironmongery'];

  // Checks a queued session (any version of the record: sessions queued
  // before photo roles existed have no role/code and are read as the
  // Delivery they were) is complete enough to send. Returns '' or the
  // problem. A session that fails this is kept and marked - never deleted.
  function sessionProblem(session, photos) {
    if (!session || typeof session !== 'object') return 'the record is empty';
    if (!session.sessionId || !UUID_PATTERN.test(String(session.sessionId))) return 'it has no valid session id';
    if (!ROLES.includes(sessionRole(session))) return `unknown photo role "${String(session.role).slice(0, 20)}"`;
    const code = sessionCode(session);
    if (typeof code !== 'string' || !code.trim()) return 'it has no scanned code';
    if (!Array.isArray(photos) || photos.length === 0) return 'it has no photographs stored';
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (!p || !p.photoId || !UUID_PATTERN.test(String(p.photoId))) return `photograph ${i + 1} has no valid id`;
      if (p.uploaded) continue;
      if (!(p.bytes instanceof ArrayBuffer) || p.bytes.byteLength === 0) return `photograph ${i + 1} has no image data`;
      if (!SHA256_PATTERN.test(String(p.sha256 || ''))) return `photograph ${i + 1} has no checksum`;
    }
    return '';
  }

  // Any API call that has not answered after `ms` is treated as timed out,
  // whatever the browser did with the request - so one stuck request can
  // never freeze sending for the rest of the page's life (the original
  // "SEND PENDING NOW does nothing" failure).
  function withDeadline(promise, ms, what) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, unreachable: true, timedOut: true, kind: 'timeout', error: `No answer from the Photo Service within ${Math.round(ms / 1000)} s (${what}).` }), ms);
    });
    return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
  }

  const DEFAULT_DEADLINES = { check: 20000, upload: 90000, complete: 30000 };

  // The sync engine. `api` talks to the Windows Photo Service and is injected
  // (the browser passes real fetch/XHR calls; tests pass fakes or a Node
  // client for a real test server):
  //   checkService()  -> { reachable, paired, role, ok?, status?, kind?, reason?, url?, authState? }
  //   uploadPhoto({ role, code, photoId, bytes, sha256 })
  //                   -> { ok } | { ok: false, error, status?, kind?, needsPairing?, wrongRole?, unreachable?, timedOut? }
  //   completeSession({ sessionId, role, code, photosSaved })
  //                   -> same shape
  // `role` is only the role the session was TAKEN as, sent so the PC can
  // refuse it clearly if this iPad is now paired as something else - the PC
  // always decides the role itself, from the pairing token.
  // `withLock(fn)` (optional) serialises sending across browser tabs - see
  // app.js, which passes the Web Locks API when the browser has it.
  // `log(event, details)` (optional) receives a diagnostic line per step -
  // never a token, never photo bytes.
  function createSyncEngine({ store, api, onProgress = () => {}, withLock = (fn) => fn(), log = () => {}, deadlines = {} }) {
    const limits = { ...DEFAULT_DEADLINES, ...deadlines };
    let running = null;

    function progress(update) {
      try {
        onProgress(update);
      } catch {
        // a UI problem must never break sending
      }
    }

    function note(event, details) {
      try {
        log(event, details || {});
      } catch {
        // diagnostics must never break sending
      }
    }

    // Kind of a failed API result (an explicit kind from the api wins).
    function kindOf(result) {
      if (result.kind) return result.kind;
      if (result.needsPairing) return 'auth';
      if (result.wrongRole) return 'wrong_role';
      if (result.timedOut) return 'timeout';
      if (result.unreachable) return 'unreachable';
      if (result.status) return classifyHttpStatus(result.status);
      return 'rejected';
    }

    async function failSession(session, status, error, kind, httpStatus) {
      await store.updateSession(session.sessionId, {
        status,
        lastError: String(error || '').slice(0, 300),
        lastErrorKind: kind || '',
        lastHttpStatus: httpStatus || 0,
        lastErrorAt: new Date().toISOString()
      });
    }

    function checkService() {
      return withDeadline(api.checkService(), limits.check, 'reachability check').then((r) => (r && r.timedOut ? { reachable: false, paired: false, kind: 'timeout', reason: r.error } : r));
    }

    // Sends ONE session: every not-yet-uploaded photo in order, then the
    // session-complete report, then (only then) deletes it locally.
    // Resolves { outcome: 'sent' | 'failed' | 'needs_pairing' | 'unreachable', kind, error }.
    async function sendSession(session, pairedRole) {
      const role = sessionRole(session);
      const code = sessionCode(session);
      // Taken as one role, but this iPad has since been paired as another:
      // never sent (the PC would refuse it anyway), never deleted.
      if (pairedRole && pairedRole !== role) {
        const error = `Taken as ${role} photos, but this iPad is now paired for ${pairedRole} photos.`;
        await failSession(session, STATUS.WRONG_ROLE, error, 'wrong_role');
        return { outcome: 'failed', kind: 'wrong_role', error };
      }
      let photos;
      try {
        photos = await store.getPhotos(session.sessionId);
      } catch (err) {
        const error = `Could not read its photographs from this iPad (${(err && err.message) || err}).`;
        await failSession(session, STATUS.FAILED, error, 'storage');
        return { outcome: 'failed', kind: 'storage', error };
      }
      const problem = sessionProblem(session, photos);
      if (problem) {
        const error = `Session format invalid: ${problem}. Its photographs are kept on this iPad.`;
        await failSession(session, STATUS.FAILED, error, 'format');
        note('session-invalid', { sessionId: session.sessionId, code, problem });
        return { outcome: 'failed', kind: 'format', error };
      }
      await store.updateSession(session.sessionId, { status: STATUS.SYNCING, lastAttemptAt: new Date().toISOString(), attempts: (session.attempts || 0) + 1 });

      let failure = null;
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        if (photo.uploaded) continue;
        progress({ sessionId: session.sessionId, reference: code, sending: i + 1, total: photos.length });
        note('upload-start', { sessionId: session.sessionId, code, photo: i + 1, of: photos.length, bytes: photo.bytes.byteLength });
        const result = await withDeadline(api.uploadPhoto({ role, code, photoId: photo.photoId, bytes: photo.bytes, sha256: photo.sha256 }), limits.upload, 'photo upload');
        note('upload-result', { sessionId: session.sessionId, photo: i + 1, ok: Boolean(result.ok), status: result.status || 0, kind: result.ok ? '' : kindOf(result), error: result.ok ? '' : result.error });
        if (result.ok) {
          await store.markPhotoUploaded(photo.photoId);
          continue;
        }
        const kind = kindOf(result);
        if (result.needsPairing) {
          await failSession(session, STATUS.NEEDS_PAIRING, result.error, kind, result.status);
          return { outcome: 'needs_pairing', kind, error: result.error };
        }
        if (result.wrongRole) {
          await failSession(session, STATUS.WRONG_ROLE, result.error, kind, result.status);
          return { outcome: 'failed', kind, error: result.error };
        }
        if (result.unreachable) {
          // Lost the connection (or this upload timed out) part-way: back to
          // plain "waiting", nothing lost - the uploaded photos stay marked.
          await failSession(session, STATUS.PENDING, result.error, kind, result.status);
          return { outcome: 'unreachable', kind, error: result.error };
        }
        // The PC answered but refused or could not file this photo (drive
        // offline, out of space...). Keep going with the rest - they can
        // still be filed - but this session cannot be completed this time.
        failure = failure || { error: result.error, kind, status: result.status };
      }
      if (failure) {
        await failSession(session, STATUS.FAILED, failure.error, failure.kind, failure.status);
        return { outcome: 'failed', kind: failure.kind, error: failure.error };
      }

      progress({ sessionId: session.sessionId, reference: code, completing: true });
      note('complete-start', { sessionId: session.sessionId, code, photosSaved: photos.length });
      const done = await withDeadline(api.completeSession({ sessionId: session.sessionId, role, code, photosSaved: photos.length }), limits.complete, 'session-complete report');
      note('complete-result', { sessionId: session.sessionId, ok: Boolean(done.ok), status: done.status || 0, kind: done.ok ? '' : kindOf(done), error: done.ok ? '' : done.error });
      if (!done.ok) {
        const kind = kindOf(done);
        if (done.needsPairing) {
          await failSession(session, STATUS.NEEDS_PAIRING, done.error, kind, done.status);
          return { outcome: 'needs_pairing', kind, error: done.error };
        }
        if (done.wrongRole) {
          await failSession(session, STATUS.WRONG_ROLE, done.error, kind, done.status);
          return { outcome: 'failed', kind, error: done.error };
        }
        await failSession(session, done.unreachable ? STATUS.PENDING : STATUS.FAILED, done.error, kind, done.status);
        return { outcome: done.unreachable ? 'unreachable' : 'failed', kind, error: done.error };
      }

      // Every photo came back 201 (filed and read back by the PC) and the PC
      // acknowledged the session: only now is the local copy removed.
      await store.deleteSession(session.sessionId);
      return { outcome: 'sent' };
    }

    // Sends every queued session, oldest first, one at a time. One session
    // that fails - refused, invalid, even throwing - is marked and skipped;
    // the rest are still sent. Stops early (leaving everything still queued)
    // only if the Photo Service itself cannot be reached or this iPad is no
    // longer paired. Overlapping calls share the one run already in progress
    // (and every call inside is time-limited, so that run always ends).
    // Resolves { outcome, sent, failed, deferred, kind?, reason?, status? }:
    // outcome is 'nothing' | 'unreachable' | 'service_error' | 'needs_pairing'
    // | 'done' | 'busy' | 'storage_error'.
    function syncAll({ onlySessionId, reason = '' } = {}) {
      if (running) {
        note('sync-joined', { reason });
        return running;
      }
      running = (async () => {
        note('sync-start', { reason, onlySessionId: onlySessionId || '' });
        try {
          const result = await withLock(async () => {
            let sessions;
            try {
              sessions = await store.listSessions();
            } catch (err) {
              return { outcome: 'storage_error', sent: 0, failed: 0, deferred: 0, kind: 'storage', reason: `Could not read the pending list from this iPad (${(err && err.message) || err}).` };
            }
            if (onlySessionId) sessions = sessions.filter((s) => s.sessionId === onlySessionId);
            note('queue-read', { sessions: sessions.length });
            if (sessions.length === 0) return { outcome: 'nothing', sent: 0, failed: 0, deferred: 0 };

            const service = await checkService();
            note('health', { reachable: Boolean(service.reachable), paired: Boolean(service.paired), status: service.status || 0, kind: service.kind || '', reason: service.reason || '', url: service.url || '', auth: service.authState || '' });
            if (!service.reachable) {
              const kind = service.kind || 'unreachable';
              const why = service.reason || failureLabel(kind);
              for (const s of sessions) {
                await store.updateSession(s.sessionId, { lastError: why.slice(0, 300), lastErrorKind: kind, lastHttpStatus: 0, lastErrorAt: new Date().toISOString() }).catch(() => {});
              }
              return { outcome: 'unreachable', sent: 0, failed: 0, deferred: sessions.length, kind, reason: why };
            }
            if (service.ok === false) {
              // It answered, but with an error - say exactly what.
              const kind = service.kind || classifyHttpStatus(service.status);
              return { outcome: 'service_error', sent: 0, failed: 0, deferred: sessions.length, kind, status: service.status, reason: service.reason || failureLabel(kind, service.status) };
            }
            if (!service.paired) {
              const why = service.authState === 'missing' ? 'This iPad has no pairing saved - pair it again.' : 'The Photo Service no longer recognises this iPad\'s pairing - pair it again.';
              for (const s of sessions) await failSession(s, STATUS.NEEDS_PAIRING, why, 'pairing');
              return { outcome: 'needs_pairing', sent: 0, failed: 0, deferred: sessions.length, kind: 'pairing', reason: why };
            }

            let sent = 0;
            let failed = 0;
            let deferred = 0;
            for (let index = 0; index < sessions.length; index++) {
              const session = sessions[index];
              note('session-selected', { sessionId: session.sessionId, code: sessionCode(session), role: sessionRole(session), status: session.status, attempts: session.attempts || 0 });
              let r;
              try {
                r = await sendSession(session, service.role);
              } catch (err) {
                // Something about THIS session broke the iPad side (a damaged
                // record, a storage error...). Mark it and carry on - it must
                // never stop the deliveries behind it.
                const error = `Could not send this ${sessionRole(session)} session: ${(err && err.message) || err}`;
                await failSession(session, STATUS.FAILED, error, 'internal').catch(() => {});
                r = { outcome: 'failed', kind: 'internal', error };
              }
              note('session-result', { sessionId: session.sessionId, outcome: r.outcome, kind: r.kind || '', error: r.error || '' });
              if (r.outcome === 'sent') sent++;
              else if (r.outcome === 'failed') failed++;
              else if (r.outcome === 'needs_pairing') {
                note('retry-decision', { decision: 'stop', why: 'pairing rejected - every session would be refused' });
                return { outcome: 'needs_pairing', sent, failed, deferred: sessions.length - index, kind: r.kind, reason: r.error };
              } else {
                // Unreachable or timed out on this session. Is the Photo
                // Service really gone, or was it just this one?
                deferred++;
                const again = await checkService();
                if (again.reachable && again.paired && again.ok !== false) {
                  note('retry-decision', { decision: 'continue', why: `${r.kind || 'unreachable'} on this session, but the Photo Service still answers - trying the next one` });
                  continue;
                }
                note('retry-decision', { decision: 'stop', why: 'the Photo Service stopped answering' });
                return { outcome: 'unreachable', sent, failed, deferred: deferred + (sessions.length - index - 1), kind: r.kind || 'unreachable', reason: r.error };
              }
            }
            return { outcome: 'done', sent, failed, deferred };
          });
          return result || { outcome: 'busy', sent: 0, failed: 0, deferred: 0, reason: 'Another copy of this tool on this iPad is already sending.' };
        } catch (err) {
          return { outcome: 'storage_error', sent: 0, failed: 0, deferred: 0, kind: 'internal', reason: `Sending stopped unexpectedly (${(err && err.message) || err}).` };
        } finally {
          running = null;
          progress(null);
        }
      })().then((result) => {
        note('sync-end', result);
        return result;
      });
      return running;
    }

    return { syncAll, isRunning: () => Boolean(running) };
  }

  // ---- when to send -----------------------------------------------------------

  // Foreground-only automatic sending. iPadOS does not reliably run web code
  // in the background, so this never relies on that: it tries when the tool
  // opens, whenever it comes back to the foreground (focus / becoming visible
  // / restored from the back-forward cache), when the browser reports it is
  // back online, and on a gentle timer while the page is visible (switching
  // between Wi-Fi networks does not always fire 'online'). `run` decides for
  // itself whether there is anything to do.
  function installAutoSync({ win, doc, run, intervalMs = 20000 }) {
    const visible = () => !doc || doc.visibilityState !== 'hidden';
    const trigger = (reason) => {
      if (visible()) run(reason);
    };
    const onFocus = () => trigger('focus');
    const onVisibility = () => trigger('visible');
    const onOnline = () => trigger('online');
    const onPageShow = () => trigger('pageshow');
    win.addEventListener('focus', onFocus);
    win.addEventListener('online', onOnline);
    win.addEventListener('pageshow', onPageShow);
    if (doc) doc.addEventListener('visibilitychange', onVisibility);
    const timer = intervalMs > 0 ? setInterval(() => trigger('timer'), intervalMs) : null;
    trigger('open');
    return function uninstall() {
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('online', onOnline);
      win.removeEventListener('pageshow', onPageShow);
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearInterval(timer);
    };
  }

  return { DB_NAME, STATUS, HIGH_USAGE_FRACTION, FAILURE_LABELS, openStore, deliveryMetadata, sessionMetadata, sessionRole, sessionCode, sessionProblem, classifyHttpStatus, failureLabel, sha256Hex, assessStorage, formatBytes, createSyncEngine, installAutoSync };
});
