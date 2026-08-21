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
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

const cycles = [
  { idx: 1, start: '2026-07-01', end: '2026-08-01', gross: 1000, paid: 400, pending: 600 },
  { idx: 2, start: '2026-08-01', end: '2026-09-01', gross: 1000, paid: 200, pending: 800 }
];
const context = {
  Math,
  Object,
  entryLog: [],
  todayStr: () => '2026-08-16',
  isBorrowerMonthlyType: () => true,
  _cycleIndexAt: () => 2,
  _nthCycleStart: (_borrower, index) => cycles[index - 1].start,
  _nthCycleEnd: (_borrower, index) => cycles[index - 1].end,
  _periodInterestGross: () => 1000,
  _periodInterestAccrued: () => 500,
  _principalAtDate: () => 10000,
  _lastInterestPaymentDate: () => '2026-08-10',
  _daysBetween: (start, end) => start === '2026-08-01' && end === '2026-09-01' ? 31 : 15,
  _interestCycleAllocationProjection: () => ({ cycles: cycles.map(cycle => ({ ...cycle })) }),
  fmtDate: value => value,
  fmt: value => String(value),
  _roundInterestDown10: value => value
};
vm.createContext(context);
vm.runInContext(extractFunction('_interestPaidAllocatedToCycle'), context);
vm.runInContext(extractFunction('getInterestBreakdown'), context);
vm.runInContext(extractFunction('_interestDuePeriodSummary'), context);

const borrower = { id: 'loan-1', isInterest: true, interestCredit: 0, prevPendingInterest: 9000 };
let unpaid = context.getInterestBreakdown(borrower, '2026-08-16', []);
assert.strictEqual(unpaid.currentCyclePaid, 0);

let breakdown = context.getInterestBreakdown(borrower, '2026-08-16', [{
  bid: borrower.id, date: '2026-08-10', cyclePayments: [{ idx: 2, start: '2026-08-01', end: '2026-09-01', amount: 200 }]
}]);
assert.deepStrictEqual({
  current: breakdown.currentInterest,
  cyclePaid: breakdown.currentCyclePaid,
  gross: breakdown.grossInterest,
  raw: breakdown.rawCurrent,
  prorated: breakdown.proratedInterest,
  previous: breakdown.pendingInterest,
  total: breakdown.totalDue
}, { current: 300, cyclePaid: 200, gross: 500, raw: 500, prorated: 300, previous: 600, total: 900 });

borrower.interestCredit = 100;
breakdown = context.getInterestBreakdown(borrower, '2026-08-16', [{
  bid: borrower.id, date: '2026-08-10', cyclePayments: [{ idx: 2, start: '2026-08-01', end: '2026-09-01', amount: 200 }]
}]);
assert.deepStrictEqual({ current: breakdown.currentInterest, previous: breakdown.pendingInterest, total: breakdown.totalDue }, { current: 300, previous: 500, total: 800 });

context._interestCycleAllocationProjection = () => ({ cycles: [
  { ...cycles[0] },
  { ...cycles[1], paid: 500, pending: 500 }
] });
borrower.interestCredit = 0;
breakdown = context.getInterestBreakdown(borrower, '2026-08-16', [{
  bid: borrower.id, date: '2026-08-10', cyclePayments: [{ idx: 2, start: '2026-08-01', end: '2026-09-01', amount: 500 }]
}]);
assert.deepStrictEqual({ current: breakdown.currentInterest, cyclePaid: breakdown.currentCyclePaid }, { current: 0, cyclePaid: 500 });

context._interestCycleAllocationProjection = () => ({ cycles: [
  { ...cycles[0] },
  { ...cycles[1], paid: 600, pending: 400 }
] });
breakdown = context.getInterestBreakdown(borrower, '2026-08-16', [{
  bid: borrower.id, date: '2026-08-10', cyclePayments: [{ idx: 2, start: '2026-08-01', end: '2026-09-01', amount: 600 }]
}]);
assert.deepStrictEqual({ current: breakdown.currentInterest, cyclePaid: breakdown.currentCyclePaid, previous: breakdown.pendingInterest, total: breakdown.totalDue }, { current: 0, cyclePaid: 600, previous: 600, total: 600 });

const messageSummary = context._interestDuePeriodSummary(
  breakdown,
  '2026-08-01',
  '2026-09-01',
  breakdown.currentInterest,
  75
);
assert.deepStrictEqual(
  { current: messageSummary.currentDue, previous: messageSummary.previousDue, total: messageSummary.totalDue },
  { current: 0, previous: 600, total: 600 }
);

const settledPrevious = context._interestDuePeriodSummary({
  runningCycleStart: '2026-08-01', runningCycleEnd: '2026-09-01',
  cycles: [{ idx: 1, start: '2026-07-01', end: '2026-08-01', gross: 1000, pending: 0 }, { idx: 2, start: '2026-08-01', end: '2026-09-01', gross: 1000, pending: 1000 }]
}, '2026-08-01', '2026-09-01', 500, 9000);
assert.deepStrictEqual(
  { current: settledPrevious.currentDue, previous: settledPrevious.previousDue, total: settledPrevious.totalDue },
  { current: 500, previous: 0, total: 500 }
);

assert.match(source, /function _periodInterestAccrued\(/);
assert.match(source, /function _interestPaidAllocatedToCycle\(/);
assert.match(source, /currentCyclePaid:currentCyclePaid/);
assert.match(source, /_paidCycle=Math\.max\(0,parseFloat\(_br&&_br\.currentCyclePaid\|\|0\)\|\|0\)/);
assert.match(source, /currentInterest:currentInterest/);
assert.match(source, /rawCurrent:rawCurrent/);
assert.match(source, /proratedInterest:currentInterest/);
assert.match(source, /totalDueWithArrear=previousPending\+currentInterest/);
assert.match(source, /function _auditInterestPreviousPending\(/);

console.log('Interest current-cycle breakdown tests passed.');
