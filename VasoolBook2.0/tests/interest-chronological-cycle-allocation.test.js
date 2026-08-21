'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const dates = [
  ['2026-07-01', '2026-08-01'],
  ['2026-08-01', '2026-09-01'],
  ['2026-09-01', '2026-10-01'],
  ['2026-10-01', '2026-11-01']
];
const context = {
  console,
  Math,
  Object,
  entryLog: [],
  todayStr: () => '2026-07-15',
  _cycleIndexAt: () => 1,
  _nthCycleStart: (_borrower, index) => dates[index - 1][0],
  _nthCycleEnd: (_borrower, index) => dates[index - 1][1],
  _periodInterestGross: () => 10000,
  _interestEntriesChrono: (borrower, refDate) => context.entryLog
    .filter(entry => entry.bid === borrower.id && entry.date <= refDate)
    .sort((a, b) => `${a.date}|${a.id}`.localeCompare(`${b.date}|${b.id}`))
};
vm.createContext(context);
['_interestCycleId', '_interestCycleAllocationProjection', '_interestCycleAllocationForPayment', '_interestDuePeriodSummary']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = { id: 'monthly-1', isInterest: true, loanType: 'monthly_interest' };
let allocation = context._interestCycleAllocationForPayment(borrower, 20000, '2026-07-15');
assert.deepEqual(Array.from(allocation.payments, cp => [cp.idx, cp.amount]), [[1, 10000], [2, 10000]]);
assert.ok(allocation.payments.every(cp => cp.cycleId && cp.paymentDate === '2026-07-15' && cp.allocationVersion === 2));

context.entryLog.push({ id: 'payment-full', bid: borrower.id, date: '2026-07-15', interestComponent: 20000, cyclePayments: allocation.payments });
let september = context._interestCycleAllocationProjection(borrower, 10000, '2026-09-10');
assert.deepEqual(Array.from(september.cycles, cp => [cp.idx, cp.pending]), [[1, 0], [2, 0], [3, 10000]]);

context.entryLog.length = 0;
allocation = context._interestCycleAllocationForPayment(borrower, 15000, '2026-07-15');
assert.deepEqual(Array.from(allocation.payments, cp => [cp.idx, cp.amount, cp.pendingAfter]), [[1, 10000, 0], [2, 5000, 5000]]);
context.entryLog.push({ id: 'payment-partial', bid: borrower.id, date: '2026-07-15', interestComponent: 15000, cyclePayments: allocation.payments });
september = context._interestCycleAllocationProjection(borrower, 15000, '2026-10-10');
assert.deepEqual(Array.from(september.cycles, cp => [cp.idx, cp.pending]), [[1, 0], [2, 5000], [3, 10000]]);
const dueSummary = context._interestDuePeriodSummary({ cycles: september.cycles }, '2026-09-01', '2026-10-01', 0, 0);
assert.deepEqual({ current: dueSummary.currentDue, previous: dueSummary.previousDue, total: dueSummary.totalDue }, { current: 10000, previous: 5000, total: 15000 });

assert.match(source, /function _migrateInterestCycleAllocationMetadata/);
assert.match(source, /interestCycleAllocationMigration/);
assert.match(source, /var periodLimit=600/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'early-full-payment-covers-current-and-next-cycle',
    'early-partial-payment-persists-future-cycle-balance',
    'september-keeps-august-as-previous-pending',
    'stable-cycle-id-payment-date-and-migration-audit'
  ]
}, null, 2));
