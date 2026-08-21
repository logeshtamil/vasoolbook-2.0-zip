'use strict';

// Regression test for the "content.borrowers.hash mismatch" restore/import bug.
//
// Root cause: _vbClassifyBackupValidation used to recompute the financial
// integrity hash from `data` AFTER _vbNormalizeBackupPayload had already
// mutated it (borrower loan-type repair, default period fill-in, opening-paid
// repair, legacy array unioning) and compare that POST-migration hash against
// `data.integrity.financial`, which was embedded in the backup at export time
// from the RAW pre-migration content. Any backup needing migration — which is
// most of them — produced a false-positive "content.X.hash mismatch" even
// though nothing was actually corrupted.
//
// Fix: _vbNormalizeBackupPayload now snapshots the financial-integrity hash
// BEFORE it mutates anything, and _vbClassifyBackupValidation compares against
// that stashed raw snapshot instead of recomputing from the mutated payload.

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
  // Opening-paid repair is a separate subsystem this fix does not touch;
  // fixtures below carry no opening-paid rows so a neutral no-op is faithful.
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

function freshBackup() {
  // No originalLoanAmount/originalLoanDate/period on the borrower and an old
  // loanType alias ("Monthly Interest") — exactly the shape that forces
  // _vbNormalizeBackupPayload to actually mutate the payload during restore.
  const payload = {
    app: 'VasoolBook', backupVersion: 3, version: 3, schemaVersion: 5, exportedAt: '2026-08-01T00:00:00.000Z',
    settings: { agent: 'A' },
    customers: [],
    borrowers: [{ id: 'l1', name: 'Ravi', loan: 20000, loanType: 'weekly_interest', isInterest: true, loandate: '2026-06-01' }],
    loanProfiles: [{ id: 'l1', name: 'Ravi', loan: 20000, loanType: 'weekly_interest', isInterest: true, loandate: '2026-06-01' }],
    entryLog: [{ id: 'p1', bid: 'l1', date: '2026-06-08', today: 500, interestComponent: 500 }],
    areas: [], nonAccTxns: [], upiIds: [], expenses: [], reminders: [], collReports: [],
  };
  // Embed the integrity fingerprint exactly as the exporting device does:
  // computed from the payload BEFORE any migration (there is none at export
  // time — this *is* the raw, canonical content).
  payload.integrity = { financial: context._vbFinancialIntegritySnapshot(context._vbPayloadFinancialState(payload)) };
  return payload;
}

// 1) A backup that needs migration (missing period/originalLoanAmount, which
//    normalizeBackupPayload/normalizeState both fill in) must NOT be flagged
//    as a financial content integrity mismatch.
const needsMigration = freshBackup();
const result = context._vbClassifyBackupValidation(needsMigration, 'Restore preflight');
assert.deepStrictEqual(result.critical, [], 'a backup that only needs migration must not fail self-validation: ' + JSON.stringify(result.critical));
assert.ok(needsMigration.borrowers[0].period > 0, 'sanity: normalization actually ran and mutated the payload');

// 2) Real corruption (a payment amount silently altered) must still be caught,
//    and the message must name the differing record ID, not just a generic
//    "hash mismatch".
const corrupted = freshBackup();
corrupted.entryLog[0].today = 999;
corrupted.entryLog[0].interestComponent = 999;
const corruptedResult = context._vbClassifyBackupValidation(corrupted, 'Restore preflight');
assert.ok(corruptedResult.critical.some(c => c.includes('entryLog.hash mismatch')), 'genuine content corruption is still rejected: ' + JSON.stringify(corruptedResult.critical));
assert.ok(corruptedResult.critical.some(c => c.includes('p1')), 'the mismatch message names the exact differing record ID: ' + JSON.stringify(corruptedResult.critical));

// 3) A record actually going missing must be reported too, with the count
//    delta and the missing ID, not merged into the same "hash" bucket blindly.
const dropped = freshBackup();
dropped.entryLog = [];
dropped.integrity = needsMigration.integrity; // keep the ORIGINAL embedded fingerprint (still 1 record)
const droppedResult = context._vbClassifyBackupValidation(dropped, 'Restore preflight');
assert.ok(droppedResult.critical.some(c => c.includes('entryLog.count mismatch')), 'a dropped record is reported as a count mismatch: ' + JSON.stringify(droppedResult.critical));

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'migration-only-payload-passes-self-validation',
    'genuine-corruption-still-rejected',
    'mismatch-names-differing-record-id',
    'dropped-record-reported-as-count-mismatch',
  ],
}, null, 2));
