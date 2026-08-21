const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, name + ' must exist');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('Unclosed function: ' + name);
}

const context = { Math, Date, entryLog: [], _gdBackupReadOnlyPhase: false };
vm.createContext(context);
vm.runInContext(functionSource('_vbIsOpeningPaidEntry'), context);
vm.runInContext(functionSource('_vbOpeningPaidEntryAmount'), context);
vm.runInContext(functionSource('_vbOpeningPaidMirrorEvidence'), context);
vm.runInContext(functionSource('_vbCanonicalOpeningPaidRecord'), context);
context._getOpeningPaid = borrower => Number(borrower.originalOpeningPaid || 0);
vm.runInContext(functionSource('_vbOpeningPaidAudit'), context);
vm.runInContext(functionSource('_vbOpeningPaidAmountFromLoan'), context);
vm.runInContext(functionSource('_vbNormalizeOpeningPaidRecord'), context);
vm.runInContext(functionSource('_vbEnsureOpeningPaidEntries'), context);
vm.runInContext(functionSource('_vbOpeningPaidIntegrityIssues'), context);

const borrower = { id: 'loan-1', name: 'Arun', area: 'North', loan: 10000, prev: 2500, originalOpeningPaid: 2500, openingPaidAmount: 2500, openingPrev: 2500, openingPaidTransactionId: 'opening_paid_loan-1' };
const canonical = {
  id: 'opening_paid_loan-1', bid: 'loan-1', borrowerId: 'loan-1', loanId: 'loan-1', loanProfileId: 'loan-1',
  entryType: 'opening_paid', paymentPurpose: 'opening_paid', isOpeningPaid: true, isOpeningBalance: true,
  isProtected: true, locked: true, immutable: true, canEdit: false, canDelete: false, today: 2500
};

let audit = context._vbOpeningPaidAudit({ loanProfiles: [borrower], entryLog: [canonical] });
assert.strictEqual(audit.linked, 1);
assert.strictEqual(audit.issueCount, 0);
assert.strictEqual(audit.rows[0].remainingBalance, 7500);

audit = context._vbOpeningPaidAudit({ loanProfiles: [borrower], entryLog: [] });
assert.strictEqual(audit.missing.length, 1);
assert.strictEqual(audit.rows[0].openingPaid, 2500);

audit = context._vbOpeningPaidAudit({ loanProfiles: [borrower], entryLog: [{ ...canonical, today: 2000 }] });
assert.strictEqual(audit.mismatched.length, 1);

const duplicate = { ...canonical, id: 'opening_paid_loan-1_duplicate', date: '2026-01-02', today: 9000 };
audit = context._vbOpeningPaidAudit({ loanProfiles: [borrower], entryLog: [canonical, duplicate] });
assert.strictEqual(audit.duplicates.length, 1, 'duplicate is flagged without being deleted');
assert.strictEqual(audit.rows[0].canonicalEntryId, canonical.id, 'earliest canonical record remains authoritative');
assert.strictEqual(audit.rows[0].openingPaid, 2500, 'duplicate amount is not added to Opening Paid total');

const legacyLoans = [{ ...borrower }];
const legacyLog = [];
const loansBefore = JSON.stringify(legacyLoans);
const logBefore = JSON.stringify(legacyLog);
const ensureResult = context._vbEnsureOpeningPaidEntries(legacyLoans, legacyLog);
assert.strictEqual(ensureResult.changed, false);
assert.strictEqual(ensureResult.audit.missing.length, 1);
assert.strictEqual(JSON.stringify(legacyLoans), loansBefore);
assert.strictEqual(JSON.stringify(legacyLog), logBefore);

const migrated = context._vbEnsureOpeningPaidEntries(legacyLoans, legacyLog, { explicitRepair: true, source: 'test' });
assert.strictEqual(migrated.created, 1, 'missing legacy reference creates one canonical transaction');
assert.strictEqual(legacyLog.length, 1);
assert.strictEqual(legacyLoans[0].openingPaidTransactionId, legacyLog[0].id);
assert.strictEqual(legacyLog[0].today, 2500);
assert.strictEqual(context._vbEnsureOpeningPaidEntries(legacyLoans, legacyLog, { explicitRepair: true }).created, 0, 'migration is idempotent');

const mismatchedLoan = { ...borrower, originalOpeningPaid: 3000, openingPaidAmount: 3000, openingPrev: 3000 };
const mismatchedEntry = { ...canonical };
const mismatchRepair = context._vbEnsureOpeningPaidEntries([mismatchedLoan], [mismatchedEntry], { explicitRepair: true });
assert.strictEqual(mismatchRepair.conflicts.length, 0);
assert.strictEqual(mismatchedEntry.today, 2500, 'canonical ledger amount is immutable');
assert.strictEqual(mismatchedLoan.originalOpeningPaid, 2500, 'borrower mirror is repaired from canonical ledger');
assert.ok(Array.isArray(mismatchedLoan.openingPaidLegacyValues), 'legacy mirror values remain available for audit');

const datedLoan = { ...borrower, loanStartDate: '2026-02-01', openingPaidDate: '2026-02-01' };
const datedEntry = { ...canonical, date: '2026-01-31' };
context._vbEnsureOpeningPaidEntries([datedLoan], [datedEntry], { explicitRepair: true });
assert.strictEqual(datedEntry.date, '2026-01-31', 'existing historical Opening Paid date is immutable');

const zeroLoan = { id: 'loan-zero', loan: 5000, prev: 0, originalOpeningPaid: 0, openingPaidAmount: 0, openingPrev: 0 };
const zeroLog = [];
assert.strictEqual(context._vbEnsureOpeningPaidEntries([zeroLoan], zeroLog, { explicitRepair: true }).created, 1, 'zero Opening Paid still receives one canonical record');
assert.strictEqual(zeroLog[0].today, 0);

const duplicateLoan = { ...borrower };
const duplicateCanonical = { ...canonical };
const duplicateLegacy = { ...canonical, id: 'legacy-opening-2', today: 9000, openingPaidAmount: 9000, originalOpeningPaid: 9000 };
const duplicateRepair = context._vbEnsureOpeningPaidEntries([duplicateLoan], [duplicateCanonical, duplicateLegacy], { explicitRepair: true });
assert.strictEqual(duplicateRepair.duplicatesPreserved, 1);
assert.strictEqual(duplicateLegacy.today, 9000, 'duplicate historical amount is preserved');
assert.strictEqual(duplicateLegacy.balanceNeutral, true, 'duplicate is retained but cannot inflate totals');
assert.strictEqual(duplicateCanonical.today, 2500, 'selected canonical amount remains unchanged');

const ambiguousLoan = { id: 'loan-ambiguous', loan: 10000, prev: 3000, originalOpeningPaid: 1000, openingPaidAmount: 2000, openingPrev: 3000 };
const ambiguousLog = [];
const ambiguousBefore = JSON.stringify(ambiguousLoan);
const ambiguousRepair = context._vbEnsureOpeningPaidEntries([ambiguousLoan], ambiguousLog, { explicitRepair: true });
assert.strictEqual(ambiguousRepair.conflicts.length, 1, 'ambiguous legacy values are reported');
assert.strictEqual(ambiguousLog.length, 0, 'ambiguous migration never manufactures a financial row');
assert.strictEqual(JSON.stringify(ambiguousLoan), ambiguousBefore, 'ambiguous loan is not rewritten');

const integrity = context._vbOpeningPaidIntegrityIssues({ loanProfiles: legacyLoans, entryLog: legacyLog });
assert.deepStrictEqual(Array.from(integrity.critical), [], 'migrated canonical mapping passes integrity validation');

assert.match(source, /openingPaidTransactionId=_openingPaidTransactionId/);
assert.match(source, /borrowerId:_newBid,loanId:_newBid/);
assert.match(source, /transactionType:'loan_opening_paid'/);
assert.match(source, /openingPaidAudit:\s*openingPaidAudit/);
assert.match(source, /function renderOpeningPaidLoansReport\(\)/);
assert.match(source, /function _vbCanonicalOpeningPaidRecord\(/);
assert.match(source, /function _vbOpeningPaidSaveGuard\(/);
assert.match(functionSource('_rawSaveStateFlushNow'), /_vbOpeningPaidSaveGuard\('save'\)/);
assert.match(functionSource('_rawSaveStateFast'), /_vbOpeningPaidSaveGuard\('save-fast'\)/);
const recalc = functionSource('recalcInterestLoanFromHistory');
assert.ok(!/obEntries\.forEach\(/.test(recalc), 'recalculation never rewrites every Opening Paid row');
assert.ok(!/originalOpeningPaid\s*=/.test(recalc), 'recalculation never rewrites the canonical Opening Paid mirror');

console.log('Opening Paid canonical transaction, migration, and read-only audit checks passed.');
