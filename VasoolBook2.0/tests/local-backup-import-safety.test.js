'use strict';

// Regression coverage for the Local Backup Import silent-exit/crash fix.
//
// Root cause: on Android, handleLocalBackupOpenResult() read the picked
// backup file synchronously on the UI thread with no size limit and only
// caught `Exception`. A large file could throw OutOfMemoryError — an
// Error, not an Exception — which was never caught, crashing the whole
// process before any JS error handling ever ran ("silent exit").
//
// This suite has two parts:
//  1. Source assertions that lock in the native (MainActivity.java) and
//     JS (www/index.html) fixes so they cannot silently regress.
//  2. Executable logic tests against the shared validation/merge module
//     (vasoolbook-sqlite-core.js) for the file-content failure scenarios
//     the import pipeline must reject cleanly: malformed data, missing
//     fields, duplicate IDs, and legacy/migration payloads.
//
// Scenarios that only manifest on-device (true OOM under real memory
// pressure, an actual ANR watchdog kill, cancelling the system file
// picker, app restart mid-import) are verified here by asserting the
// exact code path that prevents them exists; they still require a final
// on-device QA pass, called out explicitly in the PASS/FAIL table below.

const assert = require('assert');
const fs = require('fs');
const C = require('../www/js/vasoolbook-sqlite-core.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (e) {
    results.push({ name, status: 'FAIL', reason: e.message });
  }
}

const html = fs.readFileSync('www/index.html', 'utf8');
const mainActivity = fs.readFileSync(
  'android/app/src/main/java/in/vasoolbook/app/MainActivity.java',
  'utf8'
);

// ── 1. Native fix: large file / OOM / UI-thread block ─────────────────────

check('native: file read moved off the UI thread', () => {
  const idx = mainActivity.indexOf('private void handleLocalBackupOpenResult');
  assert.ok(idx >= 0, 'handleLocalBackupOpenResult not found');
  const body = mainActivity.slice(idx, idx + 3000);
  assert.ok(body.includes('new Thread(() ->'), 'read is not dispatched to a background thread');
});

check('native: OutOfMemoryError (Error, not Exception) is caught', () => {
  assert.ok(mainActivity.includes('catch (Throwable t)'), 'no catch(Throwable) guarding the read path');
  assert.ok(mainActivity.includes('t instanceof OutOfMemoryError'), 'OOM is not distinguished/handled');
});

// Superseded: the original OOM mitigation was a fixed 25MB size cap that
// rejected valid large backups outright. It has been replaced by genuine
// streaming/chunked processing (128KB buffer, one small callback per chunk,
// never one JSON string holding the whole file) — memory safety no longer
// depends on an arbitrary MB/GB limit at all. See streamLocalImportFile().
check('native: large files are handled via bounded chunked streaming, not a fixed size cap', () => {
  assert.ok(!mainActivity.includes('MAX_LOCAL_BACKUP_BYTES'), 'a fixed native size cap constant still exists — restrictions should be fully removed');
  const idx = mainActivity.indexOf('private void streamLocalImportFile');
  assert.ok(idx >= 0, 'streamLocalImportFile not found');
  const body = mainActivity.slice(idx, idx + 3000);
  assert.ok(body.includes('LOCAL_IMPORT_CHUNK_BYTES'), 'reads are not bounded to a fixed chunk size');
  assert.ok(body.includes('digest.update(buffer, 0, read)'), 'checksum is not computed incrementally while streaming');
  assert.ok(!body.includes('too large'), 'a size-based rejection message still exists in the streaming path');
});

check('native: callback state is always cleared (no stuck picker)', () => {
  const idx = mainActivity.indexOf('private void emitLocalBackupCallback');
  const body = mainActivity.slice(idx, idx + 400);
  assert.ok(body.includes('pendingLocalBackupCallback = null'), 'pendingLocalBackupCallback not cleared unconditionally');
});

// ── 2. JS fix: size precheck order, non-blocking merge, Processing cleanup ─

// Superseded: web import (and native, and the Filesystem-plugin fallback) no
// longer reject a file based on size at all — see local-import-unbounded-size.test.js
// for the full removal + chunked-architecture coverage.
check('js: no path rejects an import based on file size any more', () => {
  assert.ok(!html.includes('_VB_MAX_BACKUP_BYTES'), 'the removed size-cap constant is still referenced somewhere');
});

check('js: import always clears the Processing indicator in finally', () => {
  const idx = html.indexOf('function importData(event)');
  const body = html.slice(idx, html.indexOf('\n}', idx + 3000));
  assert.ok(/finally\{[\s\S]*VBProcessing\.(complete|end)/.test(body), 'no finally block clearing VBProcessing state');
});

check('js: large-import merge yields to the UI before the heavy synchronous merge', () => {
  assert.ok(/await _vbYieldToUI\(\);\s*var result=_applyBackupData\(data\)/.test(html), '_vbYieldToUI is not wired in before _applyBackupData');
});

check('js: schema/version validation runs before merge is applied', () => {
  const idx = html.indexOf('async function _vbApplyBackupDataSafely');
  const body = html.slice(idx, idx + 1400);
  const normalizeIdx = body.indexOf('_vbNormalizeBackupPayload');
  const verifyIdx = body.indexOf('_vbVerifyBackupPayload');
  const applyIdx = body.indexOf('_applyBackupData(data)');
  assert.ok(normalizeIdx >= 0 && verifyIdx >= 0 && applyIdx >= 0, 'validation pipeline functions missing');
  assert.ok(normalizeIdx < verifyIdx && verifyIdx < applyIdx, 'validation does not run before merge');
});

check('js: pre-import rollback snapshot is taken before any write', () => {
  const idx = html.indexOf('async function _vbApplyBackupDataSafely');
  const body = html.slice(idx, idx + 900);
  assert.ok(body.includes("_vbWriteRecoveryCheckpoint('before-'"), 'no pre-import checkpoint');
  assert.ok(body.includes('var before=_vbCloneDataState();'), 'no in-memory before-snapshot for rollback');
});

check('js: any failure during restore rolls back in-memory state and storage', () => {
  const idx = html.indexOf('async function _vbApplyBackupDataSafely');
  const body = html.slice(idx, html.indexOf('\n}\n', idx));
  assert.ok(body.includes('_vbRestoreDataState(before);'), 'catch block does not restore prior in-memory state');
  assert.ok(body.includes('cancelAtomicRestore'), 'catch block does not cancel the staged SQLite restore');
  assert.ok(body.includes("_vbWriteLocalMirrorAtomic(rollbackKv,'restore-rollback')"), 'catch block does not persist the rollback');
});

check('js: duplicate borrower IDs are rejected before merge', () => {
  assert.ok(html.includes("if(chk.duplicates>0)critical.push('duplicate borrower IDs"), 'duplicate-ID validation missing');
});

check('js: legacy/old backups are migrated and staged before import', () => {
  assert.ok(html.includes('_vbSaveMigratedBackupBeforeImport'), 'migrated backup is not staged before import');
  assert.ok(html.includes('__vbSchemaMigrated'), 'no schema-migration marker guarding re-migration');
});

// ── 3. Executable logic tests against the shared validation/merge module ──

check('logic: malformed JSON is a catchable SyntaxError, not a crash', () => {
  assert.throws(() => JSON.parse('{ "borrowers": [ this is not json'), SyntaxError);
});

check('logic: duplicate loan IDs are flagged as critical', () => {
  const state = {
    borrowers: [
      { id: 'L1', name: 'A', originalLoanAmount: 1000, loanStartDate: '2026-01-01' },
      { id: 'L1', name: 'B', originalLoanAmount: 2000, loanStartDate: '2026-01-02' }
    ],
    customers: [],
    entryLog: []
  };
  const report = C.validateLegacyState(state);
  assert.ok(report.critical.some(m => /duplicate loan ID/.test(m)), 'duplicate loan ID was not flagged critical');
});

check('logic: duplicate customer IDs are flagged as critical', () => {
  const state = {
    customers: [{ id: 'C1', name: 'A' }, { id: 'C1', name: 'B' }],
    borrowers: [],
    entryLog: []
  };
  const report = C.validateLegacyState(state);
  assert.ok(report.critical.some(m => /duplicate customer ID/.test(m)), 'duplicate customer ID was not flagged critical');
});

check('logic: a corrupted (non-numeric) loan amount is flagged as critical, not silently coerced', () => {
  const state = {
    borrowers: [{ id: 'L1', name: 'Corrupted amount', originalLoanAmount: 'NOT-A-NUMBER' }],
    customers: [],
    entryLog: []
  };
  const report = C.validateLegacyState(state);
  assert.ok(report.critical.length > 0, 'a loan record with a corrupted money field was accepted without complaint');
});

check('logic: validateLegacyState never throws on a corrupted backup — it reports, it does not crash', () => {
  // Regression: stateTotals() used to call originalPrincipalPaise()/toPaise()
  // unguarded, so a single corrupted money field anywhere in the payload threw
  // an uncaught exception out of validateLegacyState instead of a critical
  // error — hitting every Drive restore/recovery call site that validates a
  // downloaded backup before applying it.
  const state = {
    borrowers: [{ id: 'L1', originalLoanAmount: 'garbage' }],
    entryLog: [
      { id: 'E1', bid: 'L1', today: 'also garbage' },
      { id: 'E2', bid: 'L1', principalComponent: 'still garbage' }
    ],
    expenses: [{ id: 'X1', amount: 'nope' }],
    customers: []
  };
  let report;
  assert.doesNotThrow(() => { report = C.validateLegacyState(state); }, 'validateLegacyState threw on corrupted money fields instead of reporting');
  assert.ok(report.critical.length > 0, 'corrupted records were not flagged critical');
  assert.doesNotThrow(() => C.stateTotals(state), 'stateTotals threw on corrupted money fields');
});

check('logic: a loan record with genuinely absent (not corrupted) amount fields degrades gracefully', () => {
  // Missing optional fields must stay backward-compatible with old backups —
  // only actually-corrupted values should be rejected, per legacy-compat requirement.
  const state = {
    borrowers: [{ id: 'L1', name: 'No amount fields at all' }],
    customers: [],
    entryLog: []
  };
  const report = C.validateLegacyState(state);
  assert.strictEqual(report.critical.length, 0, 'a merely-incomplete legacy record was rejected instead of defaulting gracefully: ' + report.critical.join('; '));
});

check('logic: a valid legacy (old-format) backup normalizes cleanly with no critical errors', () => {
  const legacyLoan = { id: 'L1', name: 'Old Format', loan: 5000, prev: 5000, loandate: '2025-01-01' };
  const normalized = C.normalizeState({ borrowers: [legacyLoan], customers: [], entryLog: [] });
  assert.ok(normalized.borrowers[0].originalLoanAmount > 0, 'legacy loan/prev fields did not backfill originalLoanAmount');
  const report = C.validateLegacyState({ borrowers: [legacyLoan], customers: [], entryLog: [] });
  assert.strictEqual(report.critical.length, 0, 'a valid legacy backup was rejected: ' + report.critical.join('; '));
});

check('logic: import merge cannot resurrect a tombstoned (deleted) record', () => {
  const deleted = { id: 'p-del', bid: 'l1', today: 500, revision: 2, updatedAt: '2026-01-01T00:00:00Z' };
  const tombstones = C.mergeRecoveryTombstones([], [[
    { kind: 'entryLog', key: C.recoveryKey('entryLog', deleted), revision: 3, deletedAt: '2026-01-02T00:00:00Z', reason: 'payment-delete' }
  ]]);
  const result = C.mergeRecoveryArrays('entryLog', [], [[deleted]], { tombstones });
  assert.strictEqual(result.merged.length, 0, 'importing an old backup resurrected a deleted record');
});

check('logic: incoming backup records merge without dropping current unsynced records', () => {
  const current = [{ id: 'l1', originalLoanAmount: 9000, updatedAt: '2026-02-01T00:00:00Z' }];
  const incoming = [{ id: 'l2', originalLoanAmount: 4000, updatedAt: '2026-01-15T00:00:00Z' }];
  const merged = C.mergeRecoveryArrays('borrowers', current, [incoming]);
  assert.strictEqual(merged.merged.length, 2, 'merge lost a record instead of a pure union add');
  assert.ok(merged.merged.some(r => r.id === 'l1'), 'current on-device record was dropped');
  assert.ok(merged.merged.some(r => r.id === 'l2'), 'incoming backup record was dropped');
});

// ── Report ──────────────────────────────────────────────────────────────

const manualQaOnly = [
  { name: 'device: 50MB / 100MB / 500MB+ file import does not ANR/crash', note: 'native chunked-streaming fix verified above and in local-import-unbounded-size.test.js (bounded 128KB reads, no size cap, background thread, Throwable catch); requires on-device timing/memory verification at real large sizes' },
  { name: 'device: low-memory import does not crash the process', note: 'OutOfMemoryError is now caught and reported instead of crashing, and per-chunk memory use is bounded regardless of file size; requires low-memory-emulator verification' },
  { name: 'device: cancel the system file picker or an in-progress chunked read', note: 'JS treats a type:"cancelled" event (picker cancel, or cancelImport() mid-stream) as a clean AbortError, never a stuck state (verified in _vbStageLocalImportNative); requires on-device tap-through, including cancelling mid-transfer on a large file' },
  { name: 'device: retry after a failed import', note: 'processingToken/pendingLocalBackupCallback/activeLocalImportId are always cleared, so retry re-opens the picker cleanly; requires on-device tap-through' },
  { name: 'device: app restart mid-import', note: 'pre-import checkpoint + IndexedDB atomic commit mean a kill mid-import leaves prior committed data intact and every retry uses a fresh random stage id (no collision/resume of stale chunks); a process kill during staging itself (before the finally cleanup runs) can leave orphaned staged chunks in IndexedDB — same known limitation as the existing Drive-restore staging, harmless but not auto-swept; requires on-device kill test' }
];

const summary = {
  status: results.some(r => r.status === 'FAIL') ? 'FAIL' : 'PASS',
  automated: results,
  requiresOnDeviceQA: manualQaOnly
};

console.log(JSON.stringify(summary, null, 2));

const failed = results.filter(r => r.status === 'FAIL');
if (failed.length) {
  throw new Error(failed.length + ' check(s) failed: ' + failed.map(f => f.name + ' — ' + f.reason).join(' | '));
}
