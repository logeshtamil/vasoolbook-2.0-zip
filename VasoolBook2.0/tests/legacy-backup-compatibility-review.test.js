'use strict';

// Regression test for the legacy variant of the Drive Restore hash-mismatch
// bug: "content.borrowers.hash mismatch (record-level ID breakdown
// unavailable for this legacy backup)".
//
// Root cause: a backup created before the per-record ID/hash breakdown was
// added to financialIntegritySnapshot() only carries a rolled-up category
// {count,hash}. Comparing that against today's fingerprint rules (different
// tracked fields / legacyId scheme across app versions) produces a mismatch
// that reflects an algorithm change, not real corruption — but the code
// still pushed it into `critical`, which _vbVerifyBackupPayload throws on,
// hard-blocking restore of a perfectly valid old backup.
//
// Fix: _vbClassifyBackupValidation now detects a legacy (no `.records`)
// snapshot BEFORE attempting the strict comparison, skips the current-rules
// hash check entirely for it, and instead runs a version-appropriate
// structural self-check (counts, duplicate borrower IDs/names) that is
// surfaced as a non-blocking "Legacy Compatibility Review" instead of a
// generic failure. A genuinely corrupt/unreadable backup, or a mismatch on a
// CURRENT-format (with `.records`) snapshot, must still hard-block exactly
// as before.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const C = require('../www/js/vasoolbook-sqlite-core.js');

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

const context = {
  Object, Array, JSON, String, Number, Math, Boolean, Date, isFinite, console,
  window: {},
  BACKUP_VERSION: 5, BACKUP_SCHEMA_VERSION: 8, APP_VERSION_NAME: '2.4.53',
  isInterestLoanType(lt) { return /interest/i.test(String(lt || '')); },
  loanTypeDefaultPeriod(lt) { return /monthly/i.test(String(lt || '')) ? 1 : 12; },
  _vbEnsureOpeningPaidEntries() { return { conflicts: [], migratedLoanRecords: 0, openingPaidDatesRepaired: 0, openingPaidDatesUnresolved: 0, duplicatesPreserved: 0, created: 0, changed: false }; },
  _vbIsOpeningPaidEntry() { return false; },
  _vbOpeningPaidIntegrityIssues() { return { critical: [], warnings: [] }; },
  _storageAudit() {},
};
context.window.VBSqliteCore = C;
vm.createContext(context);
[
  '_vbChecksum', '_vbFinancialIntegritySnapshot', '_vbPayloadFinancialState',
  '_vbParseLegacyJson', '_vbFlattenHistoryMap', '_vbMigrationRecordKey', '_vbUnionMigrationArrays',
  '_vbGetMigrationReport', '_vbNormalizeBackupPayload', 'sourceHasSettings',
  '_vbFinancialSnapshotIsLegacy', '_vbLegacyCompatibilityReview', '_vbClassifyBackupValidation',
].forEach(name => vm.runInContext(extractFunction(name), context));

function legacyPayload() {
  const payload = {
    app: 'VasoolBook', backupVersion: 2, version: 2, schemaVersion: 3, exportedAt: '2024-01-10T00:00:00.000Z',
    settings: { agent: 'A' },
    customers: [],
    borrowers: [
      { id: 'l1', name: 'Suresh', loan: 15000, loanType: 'weekly_interest', isInterest: true, loandate: '2023-12-01', period: 20 },
      { id: 'l2', name: 'Geeta', loan: 8000, loanType: 'weekly', isInterest: false, loandate: '2023-11-01', period: 15 },
    ],
    loanProfiles: [
      { id: 'l1', name: 'Suresh', loan: 15000, loanType: 'weekly_interest', isInterest: true, loandate: '2023-12-01', period: 20 },
      { id: 'l2', name: 'Geeta', loan: 8000, loanType: 'weekly', isInterest: false, loandate: '2023-11-01', period: 15 },
    ],
    entryLog: [{ id: 'p1', bid: 'l1', date: '2023-12-08', today: 500, interestComponent: 500 }],
    areas: [], nonAccTxns: [], upiIds: [], expenses: [], reminders: [], collReports: [],
  };
  // Simulate the OLD (pre-breakdown) shape: only category-level {count,hash},
  // computed under whatever field list that ancient app version tracked —
  // here deliberately DIFFERENT from today's hash so it provably mismatches
  // under current rules, exactly like a real cross-version legacy backup.
  payload.integrity = { financial: { version: 1, categories: { borrowers: { count: 2, hash: 'deadbeef00' }, entryLog: { count: 1, hash: 'deadbeef01' }, customers: { count: 0, hash: '0' }, areas: { count: 0, hash: '0' }, nonAccTxns: { count: 0, hash: '0' }, expenses: { count: 0, hash: '0' }, upiIds: { count: 0, hash: '0' }, tombstones: { count: 0, hash: '0' } }, hash: 'deadbeefroot' } };
  return payload;
}

// 1) A legacy (no per-record breakdown) snapshot that mismatches under
//    current hash rules must NOT block restore.
const legacy = legacyPayload();
const result = context._vbClassifyBackupValidation(legacy, 'Restore preflight');
assert.deepStrictEqual(result.critical, [], 'a legacy backup must not be hard-blocked by a cross-version hash mismatch: ' + JSON.stringify(result.critical));
assert.ok(result.warnings.some(w => w.includes('legacy backup')), 'a legacy-hash warning is still surfaced for visibility');

// 2) The Legacy Compatibility Review is populated with version + counts + dup info.
assert.ok(result.legacyReview, 'legacyReview is attached to the classification result');
assert.strictEqual(result.legacyReview.sourceBackupVersion, 2, 'detects the correct legacy backup version');
assert.strictEqual(result.legacyReview.sourceSchemaVersion, 3, 'detects the correct legacy schema version');
assert.strictEqual(result.legacyReview.counts.borrowers, 2, 'review reports the correct borrower count');
assert.strictEqual(result.legacyReview.counts.entryLog, 1, 'review reports the correct history count');

// 3) Duplicate borrower NAMES (not IDs — a duplicate ID is a separate, still
//    genuinely-blocking structural check, unrelated to and unrelaxed by this
//    fix) are surfaced in the review for the human to see before confirming.
const legacyDup = legacyPayload();
legacyDup.borrowers.push({ id: 'l3', name: 'Suresh', loan: 5000, loanType: 'weekly', isInterest: false, loandate: '2023-10-01', period: 10 });
legacyDup.loanProfiles.push(legacyDup.borrowers[2]);
legacyDup.integrity.financial.categories.borrowers.count = 3;
const dupResult = context._vbClassifyBackupValidation(legacyDup, 'Restore preflight');
assert.deepStrictEqual(dupResult.critical, [], 'a duplicate-name-only legacy backup is still not hash-blocked: ' + JSON.stringify(dupResult.critical));
assert.ok(dupResult.legacyReview.duplicateBorrowerNames.some(n => /suresh/i.test(n)), 'duplicate borrower name surfaced in the review: ' + JSON.stringify(dupResult.legacyReview.duplicateBorrowerNames));

// 3b) A genuine duplicate borrower ID is a separate structural check that
//     this fix must NOT relax — it stays critical/blocking either way, and
//     the review still reports it for visibility.
const legacyDupId = legacyPayload();
legacyDupId.borrowers[1].id = 'l1';
legacyDupId.loanProfiles[1].id = 'l1';
const dupIdResult = context._vbClassifyBackupValidation(legacyDupId, 'Restore preflight');
assert.ok(dupIdResult.critical.some(c => c.includes('duplicate borrower IDs')), 'a genuine duplicate borrower ID still blocks restore, legacy or not');
assert.ok(dupIdResult.legacyReview.duplicateBorrowerIds.includes('l1'), 'the duplicate ID is still surfaced in the review for visibility: ' + JSON.stringify(dupIdResult.legacyReview.duplicateBorrowerIds));

// 4) A genuinely unreadable/corrupt legacy backup must still hard-block —
//    "legacy" only relaxes the hash-algorithm comparison, nothing else.
const brokenLegacy = legacyPayload();
brokenLegacy.borrowers = 'not-an-array'; delete brokenLegacy.loanProfiles;
const brokenResult = context._vbClassifyBackupValidation(brokenLegacy, 'Restore preflight');
assert.ok(brokenResult.critical.some(c => c.includes('unreadable')), 'a truly broken legacy backup is still rejected: ' + JSON.stringify(brokenResult.critical));

// 5) A CURRENT-format snapshot (carries `.records`) that mismatches must
//    still hard-block exactly as before — legacy relaxation must not weaken
//    detection of real corruption in up-to-date backups.
function currentFormatState() {
  return {
    customers: [], borrowers: [{ id: 'l1', name: 'A', loan: 1000 }], entryLog: [{ id: 'p1', bid: 'l1', today: 500 }],
    areas: [], nonAccTxns: [], upiIds: [], expenses: [], tombstones: [],
  };
}
const currentPayload = Object.assign({ app: 'VasoolBook', backupVersion: 5, version: 5, schemaVersion: 8, settings: {} }, currentFormatState(), { loanProfiles: currentFormatState().borrowers });
currentPayload.integrity = { financial: C.financialIntegritySnapshot(currentFormatState()) };
currentPayload.entryLog[0] = Object.assign({}, currentPayload.entryLog[0], { today: 999 }); // corrupt AFTER the hash was embedded
const currentResult = context._vbClassifyBackupValidation(currentPayload, 'Restore preflight');
assert.ok(currentResult.critical.some(c => c.includes('entryLog.hash mismatch')), 'a current-format backup with real corruption is still hard-blocked: ' + JSON.stringify(currentResult.critical));
assert.strictEqual(currentResult.legacyReview, null, 'a current-format backup never gets routed through the legacy review path');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'legacy-hash-mismatch-does-not-block-restore',
    'legacy-review-reports-version-and-counts',
    'legacy-review-reports-duplicate-names',
    'duplicate-borrower-id-still-blocks-restore',
    'genuinely-broken-legacy-backup-still-rejected',
    'current-format-corruption-still-hard-blocked',
  ],
}, null, 2));
