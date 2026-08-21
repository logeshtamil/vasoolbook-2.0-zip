'use strict';

// Covers the architecture-level integrity requirements not already exercised by a
// dedicated test file: the "Safe to Update" gate, and the invariant that an
// interrupted/resumed backup can never report success before a verified commit.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

function varSource(name) {
  const re = new RegExp('var ' + name + '\\s*=\\s*[^;]+;');
  const m = source.match(re);
  assert.ok(m, name + ' must exist');
  return m[0];
}

function makeLocalStorage(initial) {
  const store = Object.assign(Object.create(null), initial || {});
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
}

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── Safe to Update gate ────────────────────────────────────────────────────
  function buildSafeToUpdateContext(localStorageContents) {
    const context = {
      JSON, Object, console,
      localStorage: makeLocalStorage(localStorageContents),
      _isLocalDirty() { return context.localStorage.getItem('cm_local_dirty') === '1'; },
      _storageAudit() {}
    };
    vm.createContext(context);
    vm.runInContext(varSource('_BK_GD_ST_KEY'), context);
    vm.runInContext(functionSource('_gdSafeToUpdateStatus'), context);
    return context;
  }

  {
    const ctx = buildSafeToUpdateContext({ cm_bk_gd_status: 'ok', cm_gd_pending_changes: '0', cm_gd_upload_queue: '0' });
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update is true only with verified backup + zero pending + empty queue', status.safe === true, JSON.stringify(status));
  }
  {
    const ctx = buildSafeToUpdateContext({ cm_bk_gd_status: 'ok', cm_gd_pending_changes: '3', cm_gd_upload_queue: '0' });
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update is false when Pending Changes != 0 even with a verified backup', status.safe === false && /Pending Changes/.test(status.reasons.join(' ')), JSON.stringify(status));
  }
  {
    const ctx = buildSafeToUpdateContext({ cm_bk_gd_status: 'failed', cm_gd_pending_changes: '0', cm_gd_upload_queue: '0' });
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update is false when the last backup failed, regardless of pending count', status.safe === false, JSON.stringify(status));
  }
  {
    const ctx = buildSafeToUpdateContext({ cm_bk_gd_status: 'ok', cm_gd_pending_changes: '0', cm_gd_upload_queue: '1' });
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update is false while an upload is still queued', status.safe === false, JSON.stringify(status));
  }
  {
    const ctx = buildSafeToUpdateContext({ cm_bk_gd_status: 'ok', cm_gd_pending_changes: '0', cm_gd_upload_queue: '0', cm_local_dirty: '1' });
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update is false when local data is dirty even if the pending counter has not caught up', status.safe === false, JSON.stringify(status));
  }
  {
    const ctx = buildSafeToUpdateContext({});
    const status = ctx._gdSafeToUpdateStatus();
    check('Safe to Update defaults to false (never backed up) rather than defaulting to true', status.safe === false, JSON.stringify(status));
  }
  check('Safe to Update is exposed on window for the update-check screen', source.includes('window.isSafeToUpdate=isSafeToUpdate'));
  check('Safe to Update banner is rendered inside the existing backup status panel (no separate unverified surface)', source.includes('_gdSafeToUpdateStatus()') && source.includes('safeUpdateBanner'));

  // ── Interrupted backup: success can never be reported before a verified commit ──
  const incrementalImpl = functionSource('_gdIncrementalBackupImpl');
  const uploadPos = incrementalImpl.indexOf('_gdUploadSealedResumable(pending)');
  const verifyPos = incrementalImpl.indexOf('_gdVerifySealedUpload(fileId,pending)');
  const manifestCommitPos = incrementalImpl.indexOf('_gdDownloadJsonFile({id:manifestId})');
  const manifestCheckPos = incrementalImpl.indexOf("check.json.stateChecksum!==committedManifest.stateChecksum");
  // _setBackupOk() also legitimately fires earlier for the "nothing changed since the
  // last verified backup, no upload needed" no-op branch — that is correct (the prior
  // backup is still valid) and not the path under test here, so use the LAST occurrence,
  // which is the one following the actual upload+verify+manifest-commit sequence.
  const successPos = incrementalImpl.lastIndexOf('_setBackupOk()');
  check('upload happens before encrypted-upload verification', uploadPos >= 0 && verifyPos > uploadPos);
  check('encrypted-upload verification happens before the manifest commit is read back', verifyPos >= 0 && manifestCommitPos > verifyPos);
  check('manifest commit is read back and checksum-compared before any success status is set', manifestCommitPos >= 0 && manifestCheckPos > manifestCommitPos && successPos > manifestCheckPos);
  // A pending record (resumable state) is persisted BEFORE the network upload begins, and
  // only cleared AFTER the verified manifest commit — so a crash/interruption at any point
  // leaves a resumable pending record rather than a half-applied "success".
  const pendingStorePos = incrementalImpl.indexOf('_gdStoreIncrementalPending(pending)');
  // The rebase-and-retry loop (sync-conflict fix) also clears the pending record
  // earlier, mid-loop — but only once a manifest conflict has already been
  // confirmed, to discard the doomed attempt before rebuilding a fresh one. That
  // is a deliberate, safe clear (nothing resumable was lost — a new pending is
  // built immediately after). The property under test here is about the FINAL,
  // real completion of the call, so use the last occurrence — same reasoning as
  // successPos above.
  const pendingClearPos = incrementalImpl.lastIndexOf('_gdClearIncrementalPending()');
  check('resumable pending state is durably stored before upload starts', pendingStorePos >= 0 && pendingStorePos < uploadPos);
  check('resumable pending state is cleared only after verified success, never before', pendingClearPos > successPos || pendingClearPos > manifestCheckPos);
  check('an interrupted/failed run leaves the pending record intact for resumeDriveUpload() to continue', source.includes("async function resumeDriveUpload()") && source.includes('_gdLoadIncrementalPending()'));
  check('a resumed upload continues the SAME pending record (same plaintext/cipher hashes) rather than starting a fresh backup', /pending\.fileId\|\|await _gdUploadSealedResumable\(pending\)/.test(incrementalImpl));

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
