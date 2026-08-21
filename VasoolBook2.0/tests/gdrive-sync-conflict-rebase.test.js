'use strict';

// Verifies the Google Drive incremental-backup sync-conflict fix.
//
// Root cause (before this fix): _gdIncrementalBackupImpl already re-read the
// latest manifest right before committing (optimistic-concurrency check),
// but on a mismatch it just threw "Drive manifest changed on another
// device..." immediately — it never rebuilt the delta against the manifest
// it had just observed. Worse, a saved "pending" upload record was reused
// verbatim on every retry (manual Resume Upload or the background
// exponential-backoff retry), so a real conflict would fail forever with the
// exact same stale bytes, and only network-shaped error messages triggered
// the automatic background retry at all — a manifest conflict was a dead
// end requiring the user to notice and intervene.
//
// Fix: on a post-upload manifest mismatch, rebuild the delta fresh against
// the manifest just observed and retry the commit, bounded to
// _GD_REBASE_ATTEMPTS attempts within one call. A stale saved "pending"
// (built against a manifest that has since moved on) is detected up front
// and rebased the same way before ever re-uploading it. If every rebase
// attempt still conflicts, the failure is tagged as a distinct 'conflict'
// status (never 'failed') and always gets an automatic background retry,
// while the queued pending data and Delta Pending Changes/upload-queue
// bookkeeping are left intact — sync is never marked successful until a
// commit actually lands.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

// ── 1. Source-level: the old immediate-throw-with-no-rebase is gone, and the
//      new rebase/retry/conflict-status machinery is in place. ─────────────
const implSource = extractFunction('_gdIncrementalBackupImpl');
assert.match(implSource, /for\(var attempt=1;attempt<=_GD_REBASE_ATTEMPTS;attempt\+\+\)/, 'the commit is now attempted in a bounded rebase-and-retry loop');
assert.match(implSource, /_gdBuildIncrementalDelta\(frozenSnapshot,manifest,options\)/, 'each loop iteration (re)builds the delta against the current manifest, not a fixed one');
assert.match(implSource, /manifest=remoteNow;pending=null;await _gdClearIncrementalPending\(\)/, 'on conflict with attempts remaining, it rebases onto the manifest just observed and drops the stale pending');
assert.match(implSource, /conflictErr\._vbSyncConflict=true/, 'once rebase attempts are exhausted, the error is tagged distinctly from a generic failure');
assert.match(implSource, /isConflict\?'conflict':'failed'/, 'a sync conflict is stored as its own status, never lumped in with a generic backup failure');
assert.match(implSource, /isConflict\|\|!navigator\.onLine\|\|\/network\|fetch\|timeout\|offline\/i\.test\(e\.message\|\|''\)\)_bkScheduleRetry\(e\.message\)/, 'a sync conflict always schedules an automatic background retry, same as a network failure — never left to require a manual tap');
assert.doesNotMatch(implSource, /if\(!fullDue&&!plan\.changed\)\{await _vbIdbSet/, 'the old fixed single-attempt "no changes" inline block is gone (moved into the loop, fed by the extracted delta-builder)');

const staleGuardSource = implSource.slice(0, implSource.indexOf('try{\n    snapshotGate'));
assert.match(staleGuardSource, /String\(pending\.manifestBefore\|\|''\)!==String\(manifest\?manifest\.checksum:''\)/, 'a saved pending upload from a previous run is checked against the freshly-read manifest before ever being reused');
assert.match(staleGuardSource, /pending=null/, 'a stale saved pending (built against an old manifest) is discarded so it gets rebuilt fresh, never blindly retried');

const deltaSource = extractFunction('_gdBuildIncrementalDelta');
assert.match(deltaSource, /_gdRecordManifest\(payload,manifest&&manifest\.records\|\|\{\},recordManifestVersion\)/, 'the delta is always diffed against whatever manifest.records is passed in — the caller controls which manifest version it rebases onto');
assert.match(deltaSource, /return \{noChanges:true\}/, 'signals "nothing left to commit" instead of forcing a redundant upload — covers the case where a rebase finds the change already reflected upstream');

// ── 2. Behavioral: a manifest conflict on the first attempt is detected,
//      automatically rebased onto the newly-observed manifest, and the
//      retried commit succeeds — sync ends up 'ok', never 'failed'/'conflict'. ──
async function runScenario(opts) {
  const calls = { buildDelta: 0, uploadSealed: 0, verifySealed: 0, loadManifest: 0, uploadManifest: 0, scheduleRetry: 0, clearPending: 0, storePending: 0, setBackupOk: 0, setBackupFailed: 0 };
  const localStorageStore = {};
  const localStorage = {
    getItem: k => (k in localStorageStore ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: k => { delete localStorageStore[k]; },
  };

  // Manifest v1 is what's "remote" when we start; manifest v2 simulates
  // another device committing between our initial read and our upload.
  const manifestV1 = { checksum: 'v1', records: { borrowers: {} }, sequence: 0, baseFull: { id: 'f1', createdAt: '2026-08-01T00:00:00.000Z' }, lastSummary: null };
  const manifestV2 = { checksum: 'v2', records: { borrowers: { 'id:b9': { checksum: 'x', version: 1 } } }, sequence: 1, baseFull: { id: 'f1', createdAt: '2026-08-01T00:00:00.000Z' }, lastSummary: null, _file: { id: 'manifestFileId' } };
  let manifestReads = 0;
  let lastUploadedManifest = null;
  const remoteSequence = opts.remoteSequence; // array of manifests to return on successive _gdLoadIncrementalManifest() calls

  const context = {
    console,
    Object, Array, String, Number, Boolean, JSON, Math, Date, Error, DOMException: Error,
    localStorage,
    navigator: { onLine: true },
    _gdriveToken: 'tok', _gdTokenValidatedAt: Date.now(),
    APP_VERSION_NAME: '1.0', APP_VERSION_CODE: 1,
    _GD_INC_FORMAT: 'vasoolbook-incremental-v2',
    _GD_INC_MANIFEST_IDB: 'cm_gd_incremental_manifest_v2',
    _GD_INC_MANIFEST_NAME: 'VasoolBook_Incremental_Manifest_v2.json',
    _GD_RECORD_MANIFEST_VERSION: 2,
    _GD_SYNC_STATES: { FRESH: 'Fresh Local', REQUIRED: 'Restore Required', RESTORED: 'Restored', NORMAL: 'Normal Sync' },
    _LOCAL_DIRTY_KEY: 'cm_dirty', _BK_GD_TS_KEY: 'cm_bk_gd_ts', _BK_GD_ST_KEY: 'cm_bk_gd_status', _BK_GD_MSG_KEY: 'cm_bk_gd_msg', _BK_GD_SZ_KEY: 'cm_bk_gd_sz',

    _safeSetItem: (k, v) => localStorage.setItem(k, v),
    _gdProgress: () => {},
    _gdIsConfigured: () => true,
    _gdAutomaticSyncAllowed: () => true,
    _gdLog: () => {},
    _gdPreflightCheck: () => {},
    _gdEnsureConnected: async () => {},
    _gdAuditEvent: () => {},
    _gdRequireBackupState: async (options, manifest) => ({ state: 'Normal Sync', initialConfirmed: false, manifest }),
    _gdLoadIncrementalPending: async () => opts.savedPending || null,
    _gdLoadIncrementalManifest: async () => { const m = remoteSequence[Math.min(manifestReads, remoteSequence.length - 1)]; manifestReads++; calls.loadManifest++; return m; },
    _gdBeginImmutableBackupSnapshot: async () => ({ token: 1, snapshot: { payload: { borrowers: [] }, revision: 1, capturedAt: 'now' } }),
    _gdEndImmutableBackupSnapshot: () => {},
    _gdRecoveryKey: async () => ({ id: 'key1' }),
    _gdDeepClone: v => JSON.parse(JSON.stringify(v)),
    _gdRecordManifest: (payload, prevRecords) => {
      calls.buildDelta++;
      // Deterministic fake diff: "changed" unless prevRecords already has our one record.
      const already = prevRecords && prevRecords.borrowers && prevRecords.borrowers['id:new'];
      return already
        ? { records: prevRecords, changes: {}, changed: 0 }
        : { records: Object.assign({}, prevRecords, { borrowers: Object.assign({}, prevRecords && prevRecords.borrowers, { 'id:new': { checksum: 'c-new', version: 1 } }) }), changes: { borrowers: { upserts: [{ key: 'id:new' }], deletes: [] } }, changed: 1 };
    },
    _gdStateChecksum: async records => 'sc-' + JSON.stringify(records).length,
    _gdPrepareEnterprisePayload: async () => ({ data: {}, text: 'plaintext', size: 10, summary: { borrowers: 1 } }),
    _gdBackupSummaryFromPayload: () => ({}),
    _gdByteSize: v => String(v || '').length,
    _renderBackupStatus: () => {},
    _gdBackupSafetyRisk: () => [],
    _gdSealBackupText: async () => ({ text: 'sealed', plainSha256: 'p', cipherSha256: 'c' }),
    _gdBackupFileName: () => 'VasoolBook_Inc_000001.vbi',
    _gdStoreIncrementalPending: async () => { calls.storePending++; },
    _gdUploadSealedResumable: async () => { calls.uploadSealed++; return 'fileId-' + calls.uploadSealed; },
    _gdVerifySealedUpload: async () => { calls.verifySealed++; return true; },
    _gdClearIncrementalPending: async () => { calls.clearPending++; },
    _gdManifestCore: m => { const c = Object.assign({}, m); delete c.checksum; delete c._file; return c; },
    _gdSignManifest: async m => { m.checksum = 'signed-' + JSON.stringify(m).length; return m; },
    _gdUploadSmallJson: async (name, obj) => { calls.uploadManifest++; lastUploadedManifest = obj; return 'manifestFileId'; },
    _gdDownloadJsonFile: async () => ({ json: lastUploadedManifest }),
    _gdValidateManifest: async m => m,
    _vbIdbSet: async () => {},
    _bkRetryClear: () => {},
    _bkScheduleRetry: () => { calls.scheduleRetry++; },
    _setBackupOk: () => { calls.setBackupOk++; },
    _setBackupFailed: () => { calls.setBackupFailed++; },
    _gdSetSyncState: () => {},
    _gdCurrentDataRevision: () => 1,
    _gdPostSnapshotDifferences: () => [],
    _storageAudit: () => {},
    _gdClearTokenValidation: () => {},
    setGDriveStatus: () => {},
    showToast: () => {},
  };
  vm.createContext(context);
  vm.runInContext('async ' + extractFunction('_gdBuildIncrementalDelta'), context);
  vm.runInContext(`var _GD_REBASE_ATTEMPTS=3;`, context);
  vm.runInContext('async ' + extractFunction('_gdIncrementalBackupImpl'), context);

  let thrown = null;
  try { await context._gdIncrementalBackupImpl({}); }
  catch (e) { thrown = e; }
  return { calls, localStorage, thrown };
}

(async () => {
  // Scenario A: first upload conflicts (remote moved from v1 to v2 between
  // our pre-flight read and our post-upload check), rebase kicks in
  // automatically, and the retried commit against v2 succeeds.
  {
    const { calls, localStorage, thrown } = await runScenario({ remoteSequence: [/*gate read*/ { checksum: 'v1', records: {}, sequence: 0, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } }, /*post-upload check, attempt1*/ { checksum: 'v2', records: { borrowers: { 'id:other': { checksum: 'y', version: 1 } } }, sequence: 1, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' }, _file: { id: 'mf' } }, /*post-upload check, attempt2 — now matches*/ { checksum: 'v2', records: { borrowers: { 'id:other': { checksum: 'y', version: 1 } } }, sequence: 1, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' }, _file: { id: 'mf' } }] });
    assert.strictEqual(thrown, null, 'no error escapes — the conflict was resolved automatically: ' + (thrown && thrown.message));
    assert.strictEqual(calls.setBackupOk, 1, 'sync ends up marked successful once the rebased commit lands');
    assert.strictEqual(calls.setBackupFailed, 0, 'never marked failed when the rebase-and-retry succeeds');
    assert.strictEqual(calls.buildDelta, 2, 'the delta was rebuilt twice — once for the doomed first attempt, once rebased against the manifest observed after the conflict');
    assert.strictEqual(calls.uploadSealed, 2, 'a fresh sealed upload is sent for the rebased attempt, not a reused stale one');
    assert.strictEqual(calls.scheduleRetry, 0, 'no background retry is scheduled — the in-call rebase already resolved it');
    assert.strictEqual(localStorage.getItem('cm_bk_gd_status'), 'ok', 'final status is ok, not conflict or failed');
  }

  // Scenario B: every rebase attempt keeps conflicting (heavy contention) —
  // exhausts _GD_REBASE_ATTEMPTS, ends in the distinct 'conflict' status
  // (never 'failed'), and an automatic background retry gets scheduled.
  {
    const alwaysMoving = [
      { checksum: 'v1', records: {}, sequence: 0, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
      { checksum: 'v2', records: {}, sequence: 1, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
      { checksum: 'v3', records: {}, sequence: 2, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
      { checksum: 'v4', records: {}, sequence: 3, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
    ];
    const { calls, localStorage, thrown } = await runScenario({ remoteSequence: alwaysMoving });
    assert.ok(thrown, 'the error still surfaces to the caller after exhausting rebase attempts');
    assert.ok(thrown._vbSyncConflict, 'the exhausted-rebase error is tagged as a sync conflict');
    assert.strictEqual(calls.setBackupOk, 0, 'sync is never marked successful when it never actually committed');
    assert.strictEqual(localStorage.getItem('cm_bk_gd_status'), 'conflict', 'status is the distinct "conflict" state, not a generic "failed"');
    assert.strictEqual(calls.scheduleRetry, 1, 'an automatic background retry is scheduled — a conflict is never left to require a manual tap');
    assert.strictEqual(calls.buildDelta, 3, 'exactly _GD_REBASE_ATTEMPTS delta rebuilds were attempted, one per rebase');
    assert.strictEqual(calls.clearPending, 2, 'each failed attempt (but the last) clears its doomed pending so the next rebuild starts clean — never resent unmodified');
  }

  // Scenario C: a saved pending upload from a previous run/app-restart, built
  // against an old manifest that has since moved on, must never be blindly
  // re-uploaded — it gets detected as stale and rebased before any upload.
  {
    const stalePending = { manifestBefore: 'v-old', fileName: 'stale.vbi', sealedText: 'stale-bytes', kind: 'incremental', plan: { records: {}, stateChecksum: 'stale-sc', recordManifestVersion: 2, changed: 1, sequence: 1, previousManifest: null }, plainSha256: 'p', cipherSha256: 'c', keyId: 'key1', createdAt: '2000-01-01T00:00:00.000Z', snapshotRevision: 1 };
    const { calls, thrown, localStorage } = await runScenario({
      savedPending: stalePending,
      remoteSequence: [
        { checksum: 'v-current', records: {}, sequence: 5, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
        { checksum: 'v-current', records: {}, sequence: 5, baseFull: { id: 'f1', createdAt: '2000-01-01T00:00:00.000Z' } },
      ],
    });
    assert.strictEqual(thrown, null, 'stale pending is rebased and committed cleanly: ' + (thrown && thrown.message));
    assert.strictEqual(calls.buildDelta, 1, 'the stale pending is discarded and rebuilt fresh exactly once — never uploaded as-is');
    assert.strictEqual(calls.setBackupOk, 1);
    assert.strictEqual(localStorage.getItem('cm_bk_gd_status'), 'ok');
  }

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'rebase-retry-loop-present-in-source',
      'delta-rebuilt-each-attempt-against-current-manifest',
      'conflict-rebases-onto-observed-manifest-and-drops-stale-pending',
      'exhausted-rebase-error-tagged-as-sync-conflict',
      'conflict-status-distinct-from-generic-failure',
      'conflict-always-schedules-automatic-background-retry',
      'old-fixed-single-attempt-no-changes-block-removed',
      'stale-saved-pending-detected-and-discarded-up-front',
      'delta-builder-diffs-against-passed-in-manifest',
      'delta-builder-signals-no-changes-without-forcing-upload',
      'scenario-conflict-then-rebase-succeeds',
      'scenario-persistent-conflict-ends-in-conflict-status-with-auto-retry',
      'scenario-stale-saved-pending-rebased-before-reupload',
    ],
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
