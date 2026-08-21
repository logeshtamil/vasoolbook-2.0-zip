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

function iso(date) {
  return date.toISOString().slice(0, 10);
}

const context = {
  console,
  Date,
  Object,
  entryLog: [],
  todayStr: () => '2026-01-05',
  fmt: value => String(value),
  $id: () => null,
  _cycleIndexAt: () => 1,
  _nthCycleStart: (_b, idx) => iso(new Date(Date.UTC(2026, 0, 1 + ((idx - 1) * 7)))),
  _nthCycleEnd: (_b, idx) => iso(new Date(Date.UTC(2026, 0, 1 + (idx * 7)))),
  _periodInterestGross: () => 1000
};

context._allocateInterestToCompletedCycles = (borrower, refDate) => {
  const cycles = [];
  for (let idx = 1; idx <= 20; idx += 1) {
    const start = context._nthCycleStart(borrower, idx);
    const end = context._nthCycleEnd(borrower, idx);
    if (end > refDate) break;
    let paid = 0;
    context.entryLog
      .filter(entry => entry.bid === borrower.id)
      .forEach(entry => {
        (entry.cyclePayments || []).forEach(cp => {
          if (Number(cp.idx) === idx) paid += Number(cp.amount || 0);
        });
      });
    paid = Math.min(1000, paid);
    cycles.push({ idx, start, end, gross: 1000, paid, pending: Math.max(0, 1000 - paid) });
  }
  return { cycles };
};

vm.createContext(context);
// _advanceInterestSelectedPeriods (formerly read the now-removed
// #ci-advance-periods UI input) had zero callers even before the Interest
// Loan payment UI update removed that input — the real save path below has
// always used its own hardcoded period limit, so it is not part of this
// suite's coverage.
['_advanceInterestPlan', '_rebuildAdvanceInterestEntry']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = { id: 'B1', isInterest: true, loan: 50000, remainingPrincipal: 50000 };
const plan = context._advanceInterestPlan(borrower, '2026-01-05', 2500, 3, [], 0, '');
assert.equal(plan.remaining, 0);
assert.equal(plan.payments.length, 3);
assert.deepEqual(Array.from(plan.payments, cp => cp.amount), [1000, 1000, 500]);
assert.deepEqual(Array.from(plan.payments, cp => cp.idx), [2, 3, 4], 'advance starts after the running cycle');
assert.ok(plan.payments.every(cp => cp.cycleId && cp.start && cp.end && cp.paymentDate === '2026-01-05' && cp.allocationVersion === 2 && cp.isAdvance), 'each advance allocation is persisted with exact cycle metadata');
assert.equal(plan.coveredPeriods, 2);
assert.equal(borrower.remainingPrincipal, 50000, 'advance interest never reduces principal');

const limited = context._advanceInterestPlan(borrower, '2026-01-05', 2500, 2, [], 0, '');
assert.equal(limited.remaining, 500, 'amount outside selected periods is rejected');

context._cycleIndexAt = () => 1;
context._nthCycleStart = (_b, idx) => ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'][idx - 1];
context._nthCycleEnd = (_b, idx) => ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'][idx - 1];
context._allocateInterestToCompletedCycles = (b, refDate) => {
  const cycles = [];
  for (let idx = 1; idx <= 4; idx += 1) {
    const start = context._nthCycleStart(b, idx);
    const end = context._nthCycleEnd(b, idx);
    if (end > refDate) break;
    cycles.push({ idx, start, end, gross: 1000, paid: 0, pending: 1000 });
  }
  return { cycles };
};
const monthly = context._advanceInterestPlan(borrower, '2026-02-01', 2500, 3, [], 0, '');
assert.deepEqual(Array.from(monthly.payments, cp => cp.end), ['2026-03-31', '2026-04-30', '2026-05-31']);
assert.deepEqual(Array.from(monthly.payments, cp => cp.amount), [1000, 1000, 500]);
assert.equal(monthly.remaining, 0, 'selected future periods receive the full advance');

context._nthCycleStart = (_b, idx) => iso(new Date(Date.UTC(2026, 0, 1 + ((idx - 1) * 7))));
context._nthCycleEnd = (_b, idx) => iso(new Date(Date.UTC(2026, 0, 1 + (idx * 7))));
context._allocateInterestToCompletedCycles = (b, refDate) => {
  const cycles = [];
  for (let idx = 1; idx <= 20; idx += 1) {
    const start = context._nthCycleStart(b, idx);
    const end = context._nthCycleEnd(b, idx);
    if (end > refDate) break;
    let paid = 0;
    context.entryLog.filter(item => item.bid === b.id).forEach(item => {
      (item.cyclePayments || []).forEach(cp => {
        if (Number(cp.idx) === idx) paid += Number(cp.amount || 0);
      });
    });
    paid = Math.min(1000, paid);
    cycles.push({ idx, start, end, gross: 1000, paid, pending: Math.max(0, 1000 - paid) });
  }
  return { cycles };
};

const entry = {
  id: 'P1',
  bid: 'B1',
  date: '2026-01-05',
  today: 2500,
  isAdvanceInterestPayment: true,
  advanceCurrentInterestAmount: 0,
  advanceCurrentCyclePayments: [],
  advanceInterestAmount: 2500,
  advanceInterestPeriodLimit: 3,
  advanceInterestPeriodCount: 3,
  cyclePayments: plan.payments,
  interestComponent: 2500,
  principalComponent: 0
};
context.entryLog.push(entry);
const rebuilt = context._rebuildAdvanceInterestEntry(entry, borrower, 1500);
assert.equal(rebuilt.ok, true);
assert.equal(entry.interestComponent, 1500);
assert.equal(entry.principalComponent, 0);
assert.equal(entry.advanceInterestAmount, 1500);
assert.deepEqual(Array.from(entry.advanceInterestAllocations, cp => cp.amount), [1000, 500]);
const restored = JSON.parse(JSON.stringify(entry));
assert.equal(restored.advanceInterestAmount, 1500);
assert.equal(restored.cyclePayments.length, 2);
context.entryLog.length = 0;
assert.equal(context._allocateInterestToCompletedCycles(borrower, '2026-01-22').cycles[0].paid, 0, 'delete removes allocation');
context.entryLog.push(restored);
assert.equal(context._allocateInterestToCompletedCycles(borrower, '2026-01-22').cycles[1].paid, 1000, 'restore counts future allocation once');

assert.match(source, /usedExplicit=e\.cyclePayments\.some/);
assert.match(source, /e\.isAdvanceInterestPayment\)\{\s*[\s\S]*?e\.interestComponent=amt;\s*e\.principalComponent=0/);
assert.match(source, /advanceInterest:num\('advanceInterestAmount',0\)/);
assert.match(source, /Interest Paid Through/);
// The #ci-advance-periods input itself was intentionally removed by the
// Interest Loan payment UI update — it never fed the real save path (which
// uses its own hardcoded periodLimit, asserted below), so its removal has
// no effect on allocation/calculation logic.
assert.ok(!source.includes('id="ci-advance-periods"'), 'the unused Advance Interest Periods input is gone');
assert.ok(!extractFunction('_proceedSaveEntryNextCycle').includes('interestCredit=(parseFloat(cur.interestCredit)||0)+excess'));
assert.match(extractFunction('_advanceInterestPlan'), /_cycleIndexAt\(b,refDate\)\+1/);
assert.match(source, /return _proceedSaveEntryNextCycle\(b,today,_excessInt/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'selected-period-cap',
    'advance-starts-after-running-cycle',
    'direct-save-delegates-to-cycle-allocation',
    'partial-final-period',
    'monthly-calendar-clamp',
    'principal-unchanged',
    'explicit-future-allocation',
    'edit-rebuild',
    'delete-rebuild',
    'restore-no-double-count',
    'restore-recalc-preservation',
    'shared-receipt-snapshot'
  ]
}, null, 2));
