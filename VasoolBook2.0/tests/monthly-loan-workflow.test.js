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

const context = {
  console,
  Date,
  Math,
  Object,
  Array,
  entryLog: [],
  todayStr: () => '2026-03-10',
  canonicalLoanAmount: b => Number(b.loan || 0),
  canonicalPaidTotal: b => Number(b.prev || 0),
  borrowerWeeklyPayment: b => Number(b.billingAmt || 0),
  fmtDateWithWeekday: iso => iso,
  _borrowerAreaDay: b => b.areaDay || '',
  _isWeeklyInterestLoan: b => Boolean(b && b.isInterest && b.loanType === 'weekly_interest'),
  _weeklyInterestFirstCollectionDue: () => '',
  _cycleIndexAt: () => 1,
  _nthCycleStart: b => b.loandate,
  _nthCycleEnd: b => b.loandate
};
vm.createContext(context);
[
  'isMonthlyType',
  'effectiveBorrowerLoanType',
  'isBorrowerMonthlyType',
  '_localCalendarParts',
  '_localCalendarString',
  '_localCalendarOrdinal',
  '_isoDate',
  '_dateOnly',
  '_daysBetween',
  '_daysInMonth',
  '_cycleMonthDate',
  '_isRegularMonthlyLoan',
  '_regularMonthlyLoanAmount',
  '_regularMonthlyAnchor',
  '_regularMonthlyCycleSnapshot',
  '_regularMonthlyPaymentAllocations',
  '_applyRegularMonthlyCollectionStatus',
  '_borrowerCycleStartDate',
  '_borrowerNextAreaCollectionDate',
  '_nextCycleDateAfter',
  '_borrowerNextReopenAfterPayment'
].forEach(name => vm.runInContext(extractFunction(name), context));

const monthly = {
  id: 'M-1',
  loanType: 'monthly',
  isInterest: false,
  loan: 6000,
  period: 6,
  billingAmt: 1000,
  loandate: '2026-01-10',
  areaDay: 'Sunday',
  prev: 0
};

assert.equal(context._isRegularMonthlyLoan(monthly), true);
assert.equal(context._isRegularMonthlyLoan({...monthly, loanType: 'weekly'}), false);
assert.equal(context._isRegularMonthlyLoan({...monthly, loanType: 'monthly_interest', isInterest: true}), false);
assert.equal(context._isRegularMonthlyLoan({...monthly, loanType: 'npa', npaOriginalLoanType: 'monthly'}), false, 'NPA/EMI path is protected');

assert.equal(context._borrowerCycleStartDate(monthly, '2026-03-10'), '2026-02-10', 'monthly cycle start ignores weekly area day');
assert.equal(context._borrowerNextReopenAfterPayment(monthly, '2026-03-10'), '2026-04-10', 'monthly payment advances one calendar month');
assert.equal(context._borrowerNextReopenAfterPayment({...monthly, loanType: 'weekly'}, '2026-03-10'), '2026-03-15', 'weekly area-day behavior is unchanged');
assert.equal(context._borrowerNextReopenAfterPayment({...monthly, loanType: 'monthly_interest', isInterest: true}, '2026-03-10'), '2026-03-15', 'monthly interest behavior is unchanged');

const monthEnd = {...monthly, loandate: '2026-01-31'};
assert.equal(context._nextCycleDateAfter(monthEnd, '2026-01-31'), '2026-02-28');
assert.equal(context._nextCycleDateAfter(monthEnd, '2026-02-28'), '2026-03-31');

const unpaid = context._regularMonthlyCycleSnapshot(monthly, '2026-03-10', 0);
assert.equal(unpaid.currentCycle.idx, 2);
assert.equal(unpaid.previousPending, 1000);
assert.equal(unpaid.currentDue, 1000);
assert.equal(unpaid.totalDue, 2000);
assert.equal(unpaid.nextDueDate, '2026-02-10');

const partial = context._regularMonthlyCycleSnapshot(monthly, '2026-03-10', 1500);
assert.equal(partial.previousPending, 0);
assert.equal(partial.currentDue, 500);
assert.equal(partial.nextDueDate, '2026-03-10');

const allocation = context._regularMonthlyPaymentAllocations(monthly, 1500, '2026-03-10', 0);
assert.deepEqual(allocation.payments.map(p => [p.idx, p.amount, p.paymentDate]), [
  [1, 1000, '2026-03-10'],
  [2, 500, '2026-03-10']
]);
assert.equal(allocation.remaining, 0);

const partialStatus = {...monthly};
context._applyRegularMonthlyCollectionStatus(partialStatus, '2026-03-10', 1500);
assert.equal(partialStatus.collectionDone, false, 'overdue partial Monthly payment remains Active');
assert.equal(partialStatus.nextDueDate, '');

const currentPaidStatus = {...monthly};
context._applyRegularMonthlyCollectionStatus(currentPaidStatus, '2026-03-10', 2000);
assert.equal(currentPaidStatus.collectionDone, true);
assert.equal(currentPaidStatus.nextDueDate, '2026-04-10');

const advanceStatus = {...monthly};
context._applyRegularMonthlyCollectionStatus(advanceStatus, '2026-01-20', 2000);
assert.equal(advanceStatus.collectionDone, true);
assert.equal(advanceStatus.nextDueDate, '2026-04-10', 'two paid cycles skip exactly two monthly dues');

const roundTrip = JSON.parse(JSON.stringify({monthlyCyclePayments: allocation.payments}));
assert.deepEqual(roundTrip.monthlyCyclePayments, allocation.payments, 'backup JSON preserves Monthly allocation metadata');

assert.match(source, /if\(b\.collectionDone&&_isRegularMonthlyLoan\(b\)\)/, 'restart audit repairs Monthly waiting metadata');
assert.match(source, /monthlyCycleStatus=appointmentWins\?'appointment':\(regularMonthly\?'next_month':'next_week'\)/, 'Next Month keeps its monthly status unless an appointment overrides it');
assert.match(source, /if\(_isRegularMonthlyLoan\(borrowers\[idx2\]\)\)/, 'save status has a Monthly-only branch');
assert.match(source, /if\(b\.isInterest\)_stampInterestCycleAllocationSource\(entry\)/, 'interest allocation stamping remains guarded');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'monthly-type-isolation',
    'loan-date-month-anchor',
    'area-day-non-interference',
    'month-end-clamping',
    'current-and-previous-due',
    'partial-payment-status',
    'advance-cycle-allocation',
    'original-payment-date',
    'restart-metadata-repair',
    'backup-json-round-trip',
    'weekly-interest-npa-protection'
  ]
}, null, 2));
