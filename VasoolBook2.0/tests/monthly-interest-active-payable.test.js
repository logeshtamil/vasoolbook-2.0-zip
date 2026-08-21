'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, line = false, block = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i], next = source[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && next === '/') { block = false; i += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { line = true; i += 1; continue; }
    if (ch === '/' && next === '*') { block = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

let breakdown = {};
const context = {
  Math, Object, Date, console: { assert: () => {}, warn: () => {} }, window: {},
  isFinite, parseFloat, parseInt,
  todayStr: () => '2026-10-01',
  isBorrowerMonthlyType: () => true,
  getInterestBreakdown: () => breakdown
};
vm.createContext(context);
['_monthlyInterestPayableSummary', '_recordInterestCycleCalculationMismatch', 'getInterestCycleCalculation']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = { id: 'MI-ACTIVE-PAYABLE', isInterest: true, loanType: 'monthly_interest' };
function calculate(cycles, refDate, accrued) {
  breakdown = {
    principal: 50000,
    currentInterest: accrued || 0,
    pendingInterest: 0,
    totalDue: accrued || 0,
    runningCycleStart: '2026-10-01',
    runningCycleEnd: '2026-11-01',
    cycles
  };
  return context.getInterestCycleCalculation(borrower, refDate || '2026-10-15', []);
}

let result = calculate([
  { idx: 1, start: '2026-08-01', end: '2026-09-01', gross: 3000, paid: 3000, pending: 0 },
  { idx: 2, start: '2026-09-01', end: '2026-10-01', gross: 3000, paid: 0, pending: 3000 },
  { idx: 3, start: '2026-10-01', end: '2026-11-01', gross: 3000, paid: 0, pending: 3000 }
], '2026-10-15', 1450);
assert.equal(result.currentDue, 3000, 'latest completed fully-unpaid cycle exposes its fixed due');
assert.equal(result.previousPendingDue, 0);
assert.equal(result.totalDue, 3000);
assert.equal(result.accruedCurrentDue, 1450, 'incomplete running accrual remains informational only');

result = calculate([
  { idx: 1, start: '2026-09-01', end: '2026-10-01', gross: 3000, paid: 1800, pending: 1200 },
  { idx: 2, start: '2026-10-01', end: '2026-11-01', gross: 3000, paid: 0, pending: 3000 }
], '2026-10-15', 1450);
assert.equal(result.currentDue, 1200, 'partial cycle shows only its saved remaining balance');
assert.equal(result.totalDue, 1200, 'full monthly due is not charged again');

result = calculate([
  { idx: 1, start: '2026-08-01', end: '2026-09-01', gross: 3000, paid: 2400, pending: 600 },
  { idx: 2, start: '2026-09-01', end: '2026-10-01', gross: 3000, paid: 0, pending: 3000 },
  { idx: 3, start: '2026-10-01', end: '2026-11-01', gross: 3000, paid: 0, pending: 3000 }
], '2026-10-15', 1450);
assert.equal(result.previousPendingDue, 600, 'old partial remains a separate ledger-backed previous due');
assert.equal(result.currentDue, 3000, 'new completed cycle is the current due');
assert.equal(result.totalDue, 3600, 'Total Due is exactly Previous plus Current');

result = calculate([
  { idx: 1, start: '2026-10-01', end: '2026-11-01', gross: 3000, paid: 0, pending: 3000 }
], '2026-10-15', 1450);
assert.equal(result.currentDue, 0, 'incomplete cycle is excluded from Active payable due');
assert.equal(result.previousPendingDue, 0);
assert.equal(result.totalDue, 0);

result = calculate([
  { idx: 1, start: '2026-09-01', end: '2026-10-01', gross: 3000, paid: 3000, pending: 0 },
  { idx: 2, start: '2026-10-01', end: '2026-11-01', gross: 3000, paid: 0, pending: 3000 }
], '2026-10-15', 1450);
assert.equal(result.totalDue, 0, 'fully cleared payable interest returns to Upcoming eligibility');

const renderStart = source.indexOf('function renderBorrowers(){');
const renderEnd = source.indexOf('// LOAN HISTORY PAGE', renderStart);
const renderer = source.slice(renderStart, renderEnd);
// The Active card is intentionally compact — one canonical due figure, not a full
// Previous/Current/Total breakdown (that stays in Collect and Info, per the doc
// comment on _weeklyInterestBorrowerCardDue). It still reads from the SAME
// canonical snapshot (_settle, built from interestLoanCycleDueSnapshot ->
// getInterestCycleCalculation), so verify the canonical source is wired in, not
// literal "Previous Pending Due" / "Current Due" card labels which would duplicate
// what Info/Collect/Receipt already show.
assert.match(renderer, /var _settle=typeof interestLoanCycleDueSnapshot==='function'\s*\n?\s*\?interestLoanCycleDueSnapshot\(b\)/, 'Active card due figure is sourced from the canonical per-cycle snapshot, not a separate calculation');
assert.match(renderer, /_monthlyInterestBorrowerCardDue\(_settle\)/, 'Monthly interest card reads the canonical snapshot through the shared compact-card helper');
assert.match(renderer, /_weeklyInterestBorrowerCardDue\(_settle\)/, 'Weekly interest card reads the canonical snapshot through the same shared compact-card helper');
assert.match(renderer, /_upcomingFlow\.liveCurrentDue/, 'Upcoming retains live accrual without making it payable');
const cardDueHelper = extractFunction('_weeklyInterestBorrowerCardDue');
assert.match(cardDueHelper, /snapshot\.currentDue/, 'compact card helper reads canonical currentDue');
assert.match(cardDueHelper, /snapshot\.previousPendingDue/, 'compact card helper reads canonical previousPendingDue');
assert.match(cardDueHelper, /Math\.round\(\(current\+previous\)\*100\)\/100/, 'when previous pending exists, the shown Total Due is exactly Previous + Current, never recalculated separately');
assert.ok(!extractFunction('_monthlyInterestPayableSummary').includes('saveState('), 'payable summary is read-only');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'fully-unpaid-completed-cycle','partially-paid-remaining-only','previous-plus-current-separated',
    'exact-total-sum','incomplete-cycle-excluded','fully-cleared-upcoming','active-card-canonical-fields',
    'upcoming-live-accrual-separated','no-financial-write'
  ]
}, null, 2));
