'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const borrower = {
  id: 'IL-1',
  isInterest: true,
  loan: 10000,
  principalAmt: 10000,
  remainingPrincipal: 10000,
  interestCredit: 0,
  completed: false,
  closed: false
};

const context = {
  Object,
  console,
  entryLog: [],
  todayStr: () => '2026-07-31',
  paymentModeLabel: () => 'Cash'
};

context.getInterestBreakdown = (b, ref, records) => ({
  principal: Math.max(0, 10000 - (Array.isArray(records) ? records : context.entryLog)
    .filter(e => e.bid === b.id)
    .reduce((sum, e) => sum + Number(e.principalComponent || 0), 0)),
  totalDue: 0
});
context.getInterestCycleCalculation = (b, ref, records) => context.getInterestBreakdown(b, ref, records);
context._allocateInterestToCompletedCycles = (b, ref, records) => ({
  pending: 0,
  freeRemainder: (Array.isArray(records) ? records : context.entryLog)
    .filter(e => e.bid === b.id)
    .reduce((sum, e) => sum + Number(e.interestComponent || 0), 0)
});
context._interestPreClosureQuote = () => ({ currentInterest: 500 });

vm.createContext(context);
['_interestSettlementRefDate', 'interestLoanCycleDueSnapshot', 'interestLoanSettlementSnapshot', '_clearPrematureInterestClosure', '_interestRowsThroughPayment', '_savedPaymentSnapshot']
  .forEach(name => vm.runInContext(extractFunction(name), context));

let cycleSnapshot = context.interestLoanCycleDueSnapshot(borrower, '2026-07-31');
assert.equal(cycleSnapshot.interestPending, 0, 'borrower/card position excludes running-cycle closure interest');
assert.equal(cycleSnapshot.totalDue, 10000);

let snapshot = context.interestLoanSettlementSnapshot(borrower, '2026-07-31');
assert.equal(snapshot.principalPending, 10000);
assert.equal(snapshot.interestPending, 500);
assert.equal(snapshot.totalDue, 10500);
assert.equal(snapshot.settled, false);

context.entryLog.push({
  id: 'P1',
  bid: borrower.id,
  date: '2026-07-31',
  today: 10000,
  principalComponent: 10000,
  interestComponent: 0
});
snapshot = context.interestLoanSettlementSnapshot(borrower, '2026-07-31');
assert.equal(snapshot.principalPending, 0);
assert.equal(snapshot.interestPending, 500);
assert.equal(snapshot.settled, false, 'zero principal alone never closes an interest loan');

borrower.completed = true;
borrower.closed = true;
borrower.closureLocked = true;
borrower.paidOff = true;
borrower.status = 'paid_off';
borrower.loanStatus = 'paid_off';
assert.equal(context._clearPrematureInterestClosure(borrower), true);
assert.equal(borrower.completed, false);
assert.equal(borrower.closed, false);

context.entryLog.push({
  id: 'I1',
  bid: borrower.id,
  date: '2026-07-31',
  today: 500,
  principalComponent: 0,
  interestComponent: 500
});
snapshot = context.interestLoanSettlementSnapshot(borrower, '2026-07-31');
assert.equal(snapshot.principalPaid, 10000);
assert.equal(snapshot.interestPaid, 500);
assert.equal(snapshot.principalPending, 0);
assert.equal(snapshot.interestPending, 0);
assert.equal(snapshot.totalDue, 0);
assert.equal(snapshot.settled, true);

context.entryLog = context.entryLog.filter(e => e.id !== 'I1');
assert.equal(context.interestLoanSettlementSnapshot(borrower, '2026-07-31').settled, false, 'delete restores pending interest');
context.entryLog.push({
  id: 'I1',
  bid: borrower.id,
  date: '2026-07-31',
  today: 500,
  principalComponent: 0,
  interestComponent: 500
});
assert.equal(context.interestLoanSettlementSnapshot(borrower, '2026-07-31').settled, true, 'restored payment settles once');

const principalOnlySnapshot = context.interestLoanSettlementSnapshot(
  borrower,
  '2026-07-31',
  context.entryLog.filter(e => e.id === 'P1')
);
assert.equal(principalOnlySnapshot.principalPending, 0);
assert.equal(principalOnlySnapshot.interestPending, 500);
assert.equal(principalOnlySnapshot.settled, false, 'record-scoped snapshot excludes later same-day interest payment');

const receipt = context._savedPaymentSnapshot({
  id: 'I1',
  bid: borrower.id,
  date: '2026-07-31',
  today: 500,
  total: 10500,
  balance: 0,
  principalComponent: 0,
  interestComponent: 500,
  principalPaidAfter: 10000,
  interestPaidAfter: 500,
  principalPendingAfter: 0,
  interestPendingAfter: 0,
  totalDueAfter: 0,
  isFullPaid: true
}, borrower);
assert.equal(receipt.cleared, true);
assert.equal(receipt.principalPaidTotal, 10000);
assert.equal(receipt.interestPaidTotal, 500);
assert.equal(receipt.totalDue, 0);

const recalcSource = source.slice(
  source.indexOf('function recalcInterestLoanFromHistory('),
  source.indexOf('function openEditEntry(')
);
const saveSource = source.slice(
  source.indexOf('function _proceedSaveEntry('),
  source.indexOf('function _advanceInterestSelectedPeriods(')
);
assert.ok(!recalcSource.includes('completed=remaining<=0'), 'rebuild no longer closes on principal alone');
assert.ok(saveSource.includes('var isFullyDone = _settlementAfter.settled'));
assert.ok(!saveSource.includes('var isFullyDone = (_forceClosure)'));
assert.ok(saveSource.includes("var _displayAfter=payTo==='loan_closure'?_settlementAfter:interestLoanCycleDueSnapshot"));
assert.ok(saveSource.includes('entry.principalPaidAfter=_displayAfter.principalPaid'));
assert.ok(saveSource.includes('entry.interestPendingAfter=_displayAfter.interestPending'));
assert.ok(recalcSource.includes('rowsThroughEntry=obEntries.concat(payEntries.slice(0,entryIndex+1))'));
assert.ok(source.includes('interestLoanSettlementSnapshot(b,entry.date||null,exactRows)'));
assert.match(source, /v==='loan_closure'\r?\n\s*\?interestLoanSettlementSnapshot\(selectedBorrower,selectedDate\)/);

[
  'ci-principal-paid',
  'ci-interest-paid',
  'ci-principal-pending',
  'ci-interest-pending',
  'ci-settlement-total',
  'p_principal_paid',
  'p_interest_paid',
  'p_principal_pending',
  'p_interest_pending',
  'p_interest_total_due'
].forEach(id => assert.ok(source.includes(`id="${id}"`), `${id} is rendered`));

assert.ok(source.includes('Interest Loan Position'));
assert.ok(source.includes('Principal This Payment'));
assert.ok(source.includes('Interest This Payment'));

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'completed-cycle-card-snapshot',
    'five-value-settlement-snapshot',
    'accrued-interest-closure-guard',
    'premature-closure-repair',
    'full-settlement',
    'delete-recalculation',
    'restore-recalculation',
    'same-day-entry-ledger-isolation',
    'saved-receipt-snapshot',
    'collect-alignment',
    'borrower-info-history-report-alignment'
  ]
}, null, 2));
