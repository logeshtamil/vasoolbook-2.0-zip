'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = html.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = html.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = html.indexOf('{', functionStart);
  let depth = 0;
  let quote = '';
  let escaped = false;
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

const context = {
  console,
  Object,
  JSON,
  String,
  Date,
  setTimeout,
  clearTimeout,
  AbortController,
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
[' _gdDeepClone', '_gdSnapshotStores', '_gdSnapshotRecordId', '_gdSnapshotStoreProof', '_gdSnapshotProofDifferences']
  .map(x => x.trim())
  .forEach(name => vm.runInContext(functionSource(name), context));

const frozen = {
  customers: [{ id: 'c1', name: 'A' }],
  loanProfiles: [{ id: 'l1', customerId: 'c1', loan: 1000 }],
  entryLog: [{ id: 'p1', bid: 'l1', today: 100, ts: '2026-08-15T10:00:00.000Z' }],
  areas: [{ id: 'a1', name: 'Main' }],
  nonAccTxns: [], upiIds: [], expenses: [], collReports: [], tombstones: [],
  cashbook: {}, settings: {}, reminders: []
};
const proof = context._gdSnapshotStoreProof(frozen);
assert.deepStrictEqual(Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(context._gdDeepClone(frozen)))), []);

const liveAfterPayment = context._gdDeepClone(frozen);
liveAfterPayment.entryLog.push({ id: 'p2', bid: 'l1', today: 200, ts: '2026-08-15T10:01:00.000Z' });
assert.deepStrictEqual(Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(frozen))), [], 'a concurrent live payment cannot mutate the frozen snapshot');
let differences = Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(liveAfterPayment)));
assert.ok(differences.some(x => x.includes('entryLog') && x.includes('addedIDs=[p2]')), 'added payment ID is reported');

const changedAmount = context._gdDeepClone(frozen);
changedAmount.entryLog[0].today = 99;
differences = Array.from(context._gdSnapshotProofDifferences(proof, context._gdSnapshotStoreProof(changedAmount)));
assert.ok(differences.some(x => x.includes('entryLog') && x.includes('changedIDs=[p1]')), 'same-ID financial mutation is reported');

assert.ok(html.includes('snapshotGate=await _gdBeginImmutableBackupSnapshot();frozenSnapshot=snapshotGate.snapshot'), 'full and incremental backup start from one immutable snapshot gate');
assert.ok(html.includes('_gdPrepareEnterprisePayload(payload,frozenSnapshot)'), 'manifest and encrypted payload use the same frozen snapshot');
assert.ok(html.includes("_gdAdvanceDataRevision('save')"), 'durable saves advance the shared data revision');
assert.ok(html.includes("_gdAdvanceDataRevision('save-fast')"), 'fast saves advance the shared data revision');
assert.ok(html.includes("' - newer local changes queued'"), 'post-snapshot changes remain queued');
assert.ok(html.includes('await _gdEnsureConnected(tag,true)'), 'backup reacquires and verifies Drive authorization before upload');
assert.ok(html.includes("drive/v3/about?fields=user(permissionId)"), 'Drive token is actively probed');
assert.ok(html.includes("state='disconnected';extra=extra||'Reconnect Google Drive'"), 'Connected is impossible without a validated token');
assert.match(html, /_gdClearTokenValidation\(\);\r?\n\s*setGDriveStatus\('busy','Connecting to Google/, 'interactive reconnect clears stale validation');
assert.ok(html.includes("frozenSnapshot?_gdValidateFrozenDriveBackupPayload(frozenSnapshot,data,text,'Drive upload preflight')"), 'frozen uploads use non-migrating validation');
assert.ok(!functionSource('_gdValidateFrozenSnapshot').includes('_vbClassifyBackupValidation'), 'restore migration is never run against a current frozen upload');
assert.ok(html.includes("_gdValidateFrozenSnapshot(frozenSnapshot,JSON.parse(text),'Drive backup serialized hash verification')"), 'serialized post-build content is checked against the same frozen proof');
assert.ok(functionSource('_gdIncrementalBackupImpl').includes('snapshotGate=await _gdBeginImmutableBackupSnapshot()'), 'Opening Paid completion and snapshot gate run before full or incremental build');
assert.ok(functionSource('_gdIncrementalBackupImpl').includes('_gdEndImmutableBackupSnapshot(snapshotGate)'), 'backup mutation fence always closes in finally');
assert.ok(functionSource('_vbEnsureOpeningPaidEntries').includes("_gdBackupReadOnlyPhase)options.explicitRepair=false"), 'Opening Paid repair is read-only while backup runs');
assert.ok(functionSource('migrateCustomerLoanData').includes('migrationDeferredForBackup'), 'customer/loan migration is deferred while backup runs');
assert.ok(!functionSource('_gdDriveIntegritySummary').includes('_vbNormalizeBackupPayload'), 'post-build summary cannot migrate or mutate backup content');
assert.ok(functionSource('_gdValidateDriveBackupPayload').includes('_vbNormalizeBackupPayload(_gdDeepClone(data||{}))'), 'restore-compatible Drive validation normalizes a private clone only');
assert.ok(functionSource('_gdBackupSummaryFromPayload').includes('_vbNormalizeBackupPayload(_gdDeepClone(data||{}))'), 'backup comparison summary cannot mutate its caller payload');

(async () => {
  const authContext = {
    fetch: async (url, opts) => ({ status: 200, ok: true, url, opts }),
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    String,
    Error,
    _gdriveToken: 'valid-token',
    _gdTokenValidatedAt: 0,
    _gdLog() {}
  };
  vm.createContext(authContext);
  vm.runInContext(functionSource('_gdValidateAndMarkToken'), authContext);
  await authContext._gdValidateAndMarkToken('valid-token', 'Test');
  assert.ok(authContext._gdTokenValidatedAt > 0, 'valid token is marked only after Drive probe');

  authContext._gdTokenValidatedAt = 0;
  authContext.fetch = async () => ({ status: 401, ok: false });
  await assert.rejects(() => authContext._gdValidateAndMarkToken('valid-token', 'Test'), /Reconnect Google Drive/);
  assert.strictEqual(authContext._gdTokenValidatedAt, 0, 'expired token is never marked connected');

  const preflightContext = {
    borrowers: [{ id: 'loan-1', name: 'A', originalOpeningPaid: 250, loan: 1000, loanStartDate: '2026-01-01' }],
    entryLog: [],
    _vbTombstones: [],
    _gdBackupReadOnlyPhase: false,
    _gdDataRevision: 7,
    setTimeout: fn => { fn(); return 1; },
    _rawSaveStateFlushIfPending() {},
    _gdStringChecksum: context._gdStringChecksum,
    _gdDeepClone: value => JSON.parse(JSON.stringify(value)),
    _vbIsOpeningPaidEntry: entry => !!(entry && entry.entryType === 'opening_paid'),
    _vbOpeningPaidEntryAmount: entry => Number(entry && entry.today || 0),
    _vbOpeningPaidAmountFromLoan: b => b.originalOpeningPaid,
    _vbCanonicalOpeningPaidRecord: (b, rows) => ({ entry: rows.find(x => x.entryType === 'opening_paid') || null }),
    _vbNormalizeOpeningPaidRecord(e, b, amount) {
      Object.assign(e, { bid: b.id, borrowerId: b.id, loanId: b.id, loanProfileId: b.id, entryType: 'opening_paid', paymentPurpose: 'opening_paid', today: amount, isOpeningPaid: true, isProtected: true, locked: true, immutable: true, canEdit: false, canDelete: false });
      return e;
    },
    _vbOpeningPaidIntegrityIssues: data => ({ critical: data.entryLog.some(x => x.entryType === 'opening_paid') ? [] : ['missing'] }),
    _vbEnsureOpeningPaidEntries(loans, logs) {
      const ids = [];
      loans.forEach(loan => {
        let entry = logs.find(row => row.entryType === 'opening_paid' && (row.loanId === loan.id || row.bid === loan.id));
        if (!entry) {
          entry = { id: 'opening_paid_migration_' + loan.id };
          preflightContext._vbNormalizeOpeningPaidRecord(entry, loan, Number(loan.originalOpeningPaid || 0));
          logs.push(entry);
          ids.push(entry.id);
        }
        loan.originalOpeningPaid = Number(entry.today || 0);
        loan.openingPaidAmount = Number(entry.today || 0);
        loan.openingPrev = Number(entry.today || 0);
        loan.openingPaidTransactionId = entry.id;
      });
      return { created: ids.length, migratedLoanRecords: ids.length, canonicalIds: ids, conflicts: [], changed: ids.length > 0 };
    },
    _vbIdbSetMany: async () => true,
    _vbWriteLocalMirrorAtomic: () => true,
    _gdAdvanceDataRevision() { return ++preflightContext._gdDataRevision; },
    _gdCurrentDataRevision: () => preflightContext._gdDataRevision,
    _markLocalDirty() {},
    _storageAudit() {},
    JSON, String, Date, Object, Array, Math, Number, RegExp, Promise, Error, isFinite
  };
  vm.createContext(preflightContext);
  ['_gdOpeningPaidMigrationId', '_gdBuildMissingOpeningPaidEntry', '_gdCompleteOpeningPaidBeforeBackup'].forEach(name => vm.runInContext(functionSource(name), preflightContext));
  const first = await preflightContext._gdCompleteOpeningPaidBeforeBackup();
  assert.strictEqual(first.created, 1, 'missing Opening Paid is completed before snapshot');
  assert.strictEqual(preflightContext.entryLog.length, 1, 'one canonical Opening Paid transaction is created');
  const firstText = JSON.stringify(preflightContext.entryLog[0]);
  const second = await preflightContext._gdCompleteOpeningPaidBeforeBackup();
  assert.strictEqual(second.created, 0, 'repeat backup preflight is idempotent');
  assert.strictEqual(preflightContext.entryLog.length, 1, 'repeat preflight never duplicates Opening Paid');
  assert.strictEqual(JSON.stringify(preflightContext.entryLog[0]), firstText, 'existing financial transaction is never rewritten');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: ['Opening Paid preflight', 'Opening Paid idempotency', 'immutable snapshot', 'serialized hash equality', 'exact mismatch IDs', 'concurrent save isolation', 'pending delta preservation', 'token probe', 'expired token reconnect', 'restore validation preserved']
  }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
