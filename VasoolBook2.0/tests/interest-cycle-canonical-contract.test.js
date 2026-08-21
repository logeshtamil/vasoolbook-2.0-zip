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

function functionBody(name) { return extractFunction(name); }

const context = {
  Math,
  Object,
  Date,
  console: { assert: () => {}, warn: () => {} },
  window: {},
  todayStr: () => '2026-08-09',
  getInterestBreakdown: () => ({
    principal: 50000,
    currentInterest: 1200,
    pendingInterest: 600,
    totalDue: 1800,
    runningCycleStart: '2026-08-01',
    runningCycleEnd: '2026-09-01',
    periodStart: '2026-08-01',
    dueDate: '2026-09-01',
    cycles: [
      { idx: 1, start: '2026-07-01', end: '2026-08-01', gross: 1000, pending: 600 },
      { idx: 2, start: '2026-08-01', end: '2026-09-01', gross: 1200, pending: 1200 }
    ]
  })
};
vm.createContext(context);
['_interestDuePeriodSummary', '_monthlyInterestPayableSummary', '_recordInterestCycleCalculationMismatch', 'getInterestCycleCalculation']
  .forEach(name => vm.runInContext(extractFunction(name), context));

// getInterestCycleCalculation is now canonical for BOTH loan types via
// _monthlyInterestPayableSummary: completed cycles only (end<=ref), latest
// one selected as "current", any earlier unpaid completed cycles summed as
// "previous". Cycle 2 (idx 2, end 2026-09-01) has not completed as of ref
// 2026-08-09, so it must never be treated as due — only cycle 1 (idx 1, end
// 2026-08-01, already completed) is payable. This borrower fixture carries
// no loanType (previously defaulted to the weekly branch, which used to
// select the still-RUNNING cycle's prorated interest as "current" — the
// exact "running/incomplete cycle treated as due" bug this now fixes for
// weekly loans; monthly loans never had this bug).
const calculation = context.getInterestCycleCalculation({ id: 'loan-1', isInterest: true }, '2026-08-09', []);
assert.deepStrictEqual({
  principal: calculation.principal,
  start: calculation.cycleStart,
  end: calculation.cycleEnd,
  current: calculation.currentDue,
  previous: calculation.previousPendingDue,
  total: calculation.totalDue
}, { principal: 50000, start: '2026-07-01', end: '2026-08-01', current: 600, previous: 0, total: 600 }, 'only the latest COMPLETED cycle (idx 1) is payable — the still-running cycle 2 is never treated as due');
assert.ok(Object.isFrozen(calculation));
assert.deepStrictEqual(context.window._vbInterestCycleCalculationMismatches || [], []);

// Explicit weekly-loan regression guard: an interest loan with loanType
// 'weekly_interest' must resolve identically — the running cycle 2 must
// never appear as cycleEnd/currentDue regardless of loan type.
const weeklyCalculation = context.getInterestCycleCalculation({ id: 'loan-2', isInterest: true, loanType: 'weekly_interest' }, '2026-08-09', []);
assert.notStrictEqual(weeklyCalculation.cycleEnd, '2026-09-01', 'weekly loan: the running cycle end date must never be reported as the due date');
assert.strictEqual(weeklyCalculation.cycleEnd, '2026-08-01', 'weekly loan: the latest COMPLETED cycle is the payable one, same as monthly');
assert.strictEqual(weeklyCalculation.currentDue, 600, 'weekly loan: current due is the completed cycle pending amount, not the running cycle prorated interest (1200)');

['_cachedInterestBreakdown', '_interestDueReminderMessage', '_interestPaymentMessageMeta', '_renderInterestCalcInfo', 'refreshInterestCard', '_overdueInterestRow']
  .forEach(name => assert.match(functionBody(name), /getInterestCycleCalculation/, `${name} uses canonical calculation`));

console.log('Interest cycle canonical cross-surface contract tests passed.');
