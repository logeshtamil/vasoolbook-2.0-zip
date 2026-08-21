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

let events = [];
const basePrincipal = 50000;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const context = {
  Object, Number, Math, isFinite,
  isBorrowerMonthlyType: () => true,
  _daysBetween: dayDiff,
  _principalEvents: () => events.slice(),
  _principalAtDate: (b, date) => events.filter(e => e.date <= date).reduce((p, e) => p + e.delta, basePrincipal),
  _interestCycleBillingDays: (b, start, end) => dayDiff(start, end),
  _cycleIndexAt: () => 1,
  _nthCycleStart: () => '2026-04-01',
  _nthCycleEnd: () => '2026-05-01'
};
vm.createContext(context);
[
  '_roundInterestDown10', '_monthlyFixedCycleDue', '_monthlyCycleDueDetails',
  '_periodInterestGross', '_periodInterestAccrued', '_interestProratedThroughDate',
  '_topUpInterestSplit'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id: 'MI-FIXED-1', isInterest: true, loanType: 'monthly_interest',
  interestRate: 6, fixedMonthlyDue: 3000, fixedMonthlyDuePrincipal: 50000,
  principalAmt: 50000
};

[
  ['2026-02-01', '2026-03-01', 28],
  ['2028-02-01', '2028-03-01', 29],
  ['2026-04-01', '2026-05-01', 30],
  ['2026-07-01', '2026-08-01', 31]
].forEach(([start, end, days]) => {
  events = [];
  const details = context._monthlyCycleDueDetails(borrower, start, end, end, []);
  assert.equal(details.totalCycleDays, days);
  assert.equal(details.fixedCycleDue, 3000, `${days}-day full cycle stays fixed at 3000`);
  assert.equal(details.proratedDue, 3000, `${days}-day completed cycle charges exact fixed due`);
  assert.equal(context._periodInterestGross(borrower, start, end, []), 3000);
});

events = [];
assert.equal(context._periodInterestAccrued(borrower, '2026-02-01', '2026-02-15', '2026-03-01', []), 1500, '14 of 28 days prorates to half');
assert.equal(context._interestProratedThroughDate(borrower, '2026-04-01', '2026-05-01', '2026-04-16', []), 1500, '15 of 30 days prorates to half');
assert.equal(context._interestProratedThroughDate(borrower, '2026-07-01', '2026-08-01', '2026-07-11', []), 970, 'partial due uses actual 31-day divisor and nearest-five rule');

events = [{date: '2026-04-11', delta: 10000, type: 'topup'}];
const changed = context._monthlyCycleDueDetails(borrower, '2026-04-01', '2026-05-01', '2026-05-01', []);
assert.equal(changed.fixedCycleDue, 3600, 'configured fixed due follows the principal in effect after top-up');
assert.equal(changed.cycleGrossDue, 3400, 'top-up cycle splits 10 days at 3000 and 20 days at 3600');

events = [];
const split = context._topUpInterestSplit(borrower, '2026-04-11', 10000);
assert.equal(split.fixedCycleDueBefore, 3000);
assert.equal(split.fixedCycleDueAfter, 3600);
assert.equal(split.combinedInterest, 3400);
assert.equal(split.dueDate, '2026-05-01', 'top-up does not re-anchor the cycle');

[
  'fixedMonthlyDue:', 'fixedMonthlyDuePrincipal:',
  'fixedMonthlyDue:monthlyDetails?monthlyDetails.fixedCycleDue:0',
  'preClosureFixedCycleDue:', 'preClosureProratedDue:', 'preClosureTotalDue:',
  "['Cycle From-To',cyclePeriod]", 'id="ci-closure-fixed-due"',
  'id="ci-closure-fixed-due-label"', 'id="ci-closure-prorated-due"', 'id="ci-closure-per-day"',
  "['Fixed Monthly Due',money(br.fixedMonthlyDue||br.fixedCycleDue||0)]",
  "isBorrowerMonthlyType(_b)?'Fixed Monthly Due':'Fixed Cycle Due'"
].forEach(fragment => assert.ok(source.includes(fragment), `${fragment} is integrated`));

const intimationSource = extractFunction('_interestPreClosureIntimationLines');
assert.ok(!/Fixed Monthly Due|Fixed Cycle Due|Per-Day Due|Prorated Due/.test(intimationSource), 'calculation detail labels stay in Info/Closure UI and out of the exact intimation format');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    '28-day-fixed-cycle', '29-day-fixed-cycle', '30-day-fixed-cycle',
    '31-day-fixed-cycle', 'partial-period-proration', 'topup-segmentation',
    'closure-saved-breakdown', 'canonical-fixed-monthly-due-field',
    'monthly-specific-info-and-closure-labels'
  ]
}, null, 2));
