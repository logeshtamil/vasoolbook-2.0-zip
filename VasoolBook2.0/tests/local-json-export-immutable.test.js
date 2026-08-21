'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('www/index.html', 'utf8');
const java = fs.readFileSync('android/app/src/main/java/in/vasoolbook/app/MainActivity.java', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = html.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = html.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = html.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

function memoryStorage(seed) {
  const values = new Map(Object.entries(seed || {}));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    dump: () => Object.fromEntries(values)
  };
}

const storage = memoryStorage({
  cm_bk_local_ts: '2026-08-14T10:00:00.000Z',
  cm_bk_local_msg: 'Exported previous.json',
  cm_bk_local_size: '12345'
});
const context = {
  console, JSON, String, Date, Object, Array, Math, Error,
  localStorage: storage,
  _BK_LO_TS_KEY: 'cm_bk_local_ts',
  _BK_LO_MSG_KEY: 'cm_bk_local_msg',
  _BK_LO_SZ_KEY: 'cm_bk_local_size',
  _gdStringChecksum(text) {
    text = String(text || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  }
};
vm.createContext(context);
[
  '_gdDeepClone', '_gdSnapshotStores', '_gdSnapshotRecordId', '_gdSnapshotStoreProof', '_gdSnapshotProofDifferences',
  '_vbLocalExportMetadataSnapshot', '_vbRestoreLocalExportMetadata', '_vbCommitLocalExportSuccess', '_vbRecordLocalExportFailure'
].forEach(name => vm.runInContext(functionSource(name), context));

const history = Array.from({ length: 4001 }, (_, i) => ({
  id: 'payment-' + i,
  bid: 'loan-' + (i % 75),
  today: 100 + i,
  ts: '2026-08-15T10:' + String(i % 60).padStart(2, '0') + ':00.000Z'
}));
const frozen = {
  customers: [{ id: 'customer-1' }],
  loanProfiles: [{ id: 'loan-1', loan: 50000 }],
  entryLog: history,
  areas: [], nonAccTxns: [], upiIds: [], expenses: [], collReports: [], tombstones: [],
  cashbook: {}, settings: {}, reminders: []
};
const frozenClone = context._gdDeepClone(frozen);
const proof = context._gdSnapshotStoreProof(frozenClone);
const live = context._gdDeepClone(frozen);
live.entryLog.push({ id: 'payment-concurrent', bid: 'loan-1', today: 700, ts: '2026-08-15T11:00:00.000Z' });
assert.deepStrictEqual(Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(frozenClone))), [], '4,001-row frozen export remains byte-stable');
const concurrentDiff = Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(live)));
assert.ok(concurrentDiff.some(x => x.includes('entryLog count 4001->4002') && x.includes('payment-concurrent')), 'concurrent payment is queued as an exact post-snapshot delta');

const previous = storage.dump();
assert.throws(() => context._vbCommitLocalExportSuccess({ verified: false, filename: 'failed.json' }), /not verified/);
assert.strictEqual(storage.getItem('cm_bk_local_ts'), previous.cm_bk_local_ts, 'failed write preserves previous Last Export');
assert.strictEqual(storage.getItem('cm_bk_local_msg'), previous.cm_bk_local_msg, 'failed write preserves previous filename/message');
context._vbRecordLocalExportFailure(new Error('entryLog count 4001->4002, hash old->new, revision 55'));
assert.strictEqual(storage.getItem('cm_bk_local_ts'), previous.cm_bk_local_ts, 'validation failure cannot replace success timestamp');
assert.match(storage.getItem('cm_bk_local_failure'), /^Export Failed: .*entryLog count 4001->4002.*revision 55/, 'failure reports exact store/count/hash/revision');

context._vbCommitLocalExportSuccess({
  verified: true,
  filename: 'vasoolbook_backup_retry.json',
  path: 'Downloads/VasoolBook/vasoolbook_backup_retry.json',
  size: 987654,
  sha256: 'canonical-sha256',
  revision: 56,
  pending: true
});
assert.match(storage.getItem('cm_bk_local_msg'), /vasoolbook_backup_retry\.json/, 'retry commits filename only after verified success');
assert.strictEqual(storage.getItem('cm_bk_local_size'), '987654');
assert.strictEqual(storage.getItem('cm_bk_local_revision'), '56');
assert.strictEqual(storage.getItem('cm_local_export_pending'), '1');
assert.strictEqual(storage.getItem('cm_bk_local_failure'), null, 'successful retry clears only the failure attempt status');
const restartStorage = memoryStorage(storage.dump());
assert.match(restartStorage.getItem('cm_bk_local_msg'), /vasoolbook_backup_retry\.json/, 'successful export metadata survives restart');

// exportData() is a thin wrapper: it shows the blocking Local-Export progress
// overlay (VBHandleAndroidBackButton and popstate both block navigation while
// it is up) and delegates the actual frozen-snapshot export logic to
// _exportDataImpl(), which must preserve every invariant below unchanged.
assert.match(functionSource('exportData'), /return _vbRunCriticalOp\('Preparing local backup export…',function\(\)\{return _exportDataImpl\(fromModal\);\}\);/, 'exportData shows the blocking progress overlay and delegates to the unchanged export logic');
for (const name of ['_exportDataAndroid', '_exportDataImpl']) {
  const source = functionSource(name);
  const begin = source.indexOf('_gdBeginImmutableBackupSnapshot()');
  const prepare = source.indexOf('_gdPrepareEnterprisePayload(frozenSnapshot.payload,frozenSnapshot)');
  const save = source.indexOf(name === '_exportDataAndroid' ? '_saveAndroidLocalBackup' : '_saveWebLocalBackup');
  const commit = source.indexOf('_vbCommitLocalExportSuccess');
  assert.ok(begin >= 0 && begin < prepare && prepare < save && save < commit, name + ' validates and writes one frozen revision before success metadata');
  assert.ok(source.includes('finally{_gdEndImmutableBackupSnapshot(snapshotGate);}'), name + ' always releases the shared snapshot gate');
  assert.ok(!source.includes("_safeSetItem(_BK_LO_TS_KEY"), name + ' cannot write success metadata early');
}

assert.ok(functionSource('_gdBeginImmutableBackupSnapshot').indexOf('_gdCompleteOpeningPaidBeforeBackup()') < functionSource('_gdBeginImmutableBackupSnapshot').indexOf('_gdBackupReadOnlyPhase=true'), 'Opening Paid preflight completes before the immutable phase');
assert.ok(functionSource('_gdIncrementalBackupImpl').includes('_gdBeginImmutableBackupSnapshot()'), 'Drive and Local Export use the same snapshot-lock engine');
assert.ok(java.includes('getContentResolver().openInputStream(pendingUri)'), 'Android reads the saved MediaStore file back');
assert.ok(java.includes('verifiedSize != bytes.length || !expectedSha256.equalsIgnoreCase(actualSha256)'), 'Android rejects saved size/hash mismatch');
assert.ok(java.includes('result.put("verified", true)'), 'native bridge returns explicit verified completion');
assert.ok(functionSource('_saveWebLocalBackup').includes("verified:false,method:'Browser download dispatch'"), 'unobservable browser download completion is never marked successful');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'shared Drive/Local snapshot gate', 'Opening Paid before freeze', '4,001 entryLog rows',
    'concurrent payment queued', 'exact mismatch diagnostics', 'failed metadata preserved',
    'verified retry commit', 'restart persistence', 'Android file read-back size/hash'
  ]
}, null, 2));
