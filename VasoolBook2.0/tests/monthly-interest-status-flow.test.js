'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const states = {};
const monthAfter = {
  '2026-08-10':'2026-09-10',
  '2026-08-11':'2026-09-10',
  '2026-09-10':'2026-10-10',
  '2026-10-10':'2026-11-10'
};
function calcFor(b, date) {
  return states[`${b.id}|${date}`] || {
    cycleStart:'2026-08-10', cycleEnd:'2026-09-10', runningCycleEnd:'2026-09-10',
    currentDue:0, previousPendingDue:0, totalDue:0, principal:50000,
    fixedMonthlyDue:3000, perDayDue:100, daysUsed:0, totalCycleDays:31
  };
}

const context = {
  Date, Object, Math, console, parseFloat, parseInt,
  borrowers: [],
  todayStr: () => '2026-08-10',
  _isMonthlyInterestDueLoan: b => Boolean(b && b.isInterest && b.loanType === 'monthly_interest'),
  getInterestCycleCalculation: calcFor,
  _nextCycleDateAfter: (b, date) => monthAfter[date] || '',
  _isClosedPaidOffLoan: () => false,
  _lockClosedPaidOffLoan: () => false,
  _consumeAdvanceInterestCredit: () => false,
  _borrowerEffectiveWaitingDate: b => b.nextDueDate || b.nextCollectionDate || '',
  _borrowerCycleStartDate: () => '2026-07-10',
  fmtDateWithWeekday: value => value,
  _touchRecord: () => {},
  saveState: () => { context.saved = true; },
  saved: false
};
vm.createContext(context);
[
  '_monthlyInterestWorkflowState', '_monthlyInterestDueState',
  '_monthlyInterestNextUnpaidBoundary', '_monthlyInterestNextBaseDue',
  '_scheduleMonthlyInterestCycle', '_applyMonthlyInterestPostPaymentStatus',
  '_autoRestoreMonthlyInterestLoans'
].forEach(name => vm.runInContext(extractFunction(name), context));

const base = {id:'MI',isInterest:true,loanType:'monthly_interest',remainingPrincipal:50000};
states['MI|2026-08-09'] = {
  cycleStart:'2026-07-10',cycleEnd:'2026-08-10',currentDue:0,accruedCurrentDue:2900,previousPendingDue:0,
  principal:50000,fixedMonthlyDue:3000,perDayDue:96.77,daysUsed:30,totalCycleDays:31
};
states['MI|2026-08-10'] = {
  cycleStart:'2026-07-10',cycleEnd:'2026-08-10',currentDue:3000,previousPendingDue:0,
  principal:50000,fixedMonthlyDue:3000,perDayDue:96.77,daysUsed:31,totalCycleDays:31
};

let flow = context._monthlyInterestWorkflowState(base, '2026-08-09');
assert.equal(flow.bucket, 'upcoming', 'accruing monthly cycle stays Upcoming');
assert.equal(flow.currentDue, 0, 'incomplete cycle contributes no payable Current Due');
assert.equal(flow.liveCurrentDue, 2900, 'Upcoming exposes live current calculation separately');
assert.equal(flow.fixedMonthlyDue, 3000);
assert.equal(flow.isDue, false, 'monthly cycle never activates early');

flow = context._monthlyInterestWorkflowState(base, '2026-08-10');
assert.equal(flow.bucket, 'active', 'exact due date activates the full due');
assert.equal(flow.payableDue, 3000);
assert.equal(flow.isDue, true);

states['MI-ARREAR|2026-08-09'] = {
  cycleStart:'2026-08-01',cycleEnd:'2026-09-01',currentDue:800,previousPendingDue:500,
  principal:50000,fixedMonthlyDue:3000,daysUsed:8,totalCycleDays:31
};
flow = context._monthlyInterestWorkflowState({...base,id:'MI-ARREAR'}, '2026-08-09');
assert.equal(flow.bucket, 'active', 'verified previous pending stays Active before current due');
assert.equal(flow.payableDue, 500, 'accruing current due is not prematurely payable');

states['MI-PARTIAL|2026-08-10'] = states['MI|2026-08-10'];
context.borrowers = [{...base,id:'MI-PARTIAL'}];
let post = context._applyMonthlyInterestPostPaymentStatus(0, '2026-08-10', 375, true);
assert.equal(post.closedForCycle, true, 'partial payment enters same-day verification');
assert.equal(context.borrowers[0].monthlyCycleStatus, 'partial_verification');
assert.equal(context.borrowers[0]._closedTabDate, '2026-08-10');
states['MI-PARTIAL|2026-08-10'] = {...states['MI|2026-08-10'],currentDue:375};
assert.equal(context._monthlyInterestWorkflowState(context.borrowers[0], '2026-08-10').bucket, 'closed');
states['MI-PARTIAL|2026-08-11'] = {
  cycleStart:'2026-08-11',cycleEnd:'2026-09-10',currentDue:0,previousPendingDue:375,
  principal:50000,fixedMonthlyDue:3000,daysUsed:0,totalCycleDays:30
};
assert.equal(context._monthlyInterestWorkflowState(context.borrowers[0], '2026-08-11').bucket, 'active', 'partial returns Active next day');

states['MI-FULL|2026-08-10'] = {...states['MI|2026-08-10'],currentDue:0};
context.borrowers = [{...base,id:'MI-FULL'}];
post = context._applyMonthlyInterestPostPaymentStatus(0, '2026-08-10', 0, true);
assert.equal(post.nextDueDate, '2026-09-10');
assert.equal(context.borrowers[0].monthlyCycleStatus, 'upcoming_due');
assert.equal(context._monthlyInterestWorkflowState(context.borrowers[0], '2026-08-10').bucket, 'upcoming', 'full clear returns to Upcoming');

context.borrowers = [{...base,id:'MI-PRINCIPAL'}];
assert.equal(context._applyMonthlyInterestPostPaymentStatus(0, '2026-08-10', 500, false).handled, false, 'principal-only payment does not complete the due cycle');

states['MI-PREPAID|2026-08-10'] = {...states['MI|2026-08-10'],currentDue:0};
states['MI-PREPAID|2026-09-10'] = {
  cycleStart:'2026-08-10',cycleEnd:'2026-09-10',currentDue:0,previousPendingDue:0,
  principal:50000,fixedMonthlyDue:3000,daysUsed:31,totalCycleDays:31
};
states['MI-PREPAID|2026-10-10'] = {
  cycleStart:'2026-09-10',cycleEnd:'2026-10-10',currentDue:3000,previousPendingDue:0,
  principal:50000,fixedMonthlyDue:3000,daysUsed:30,totalCycleDays:30
};
assert.equal(context._monthlyInterestNextUnpaidBoundary({...base,id:'MI-PREPAID'}, '2026-08-10', '2026-10-10'), '2026-10-10', 'advance-paid cycles are skipped without duplication');

context.borrowers = [{...base,id:'MI',collectionDone:false,monthlyCycleStatus:''}];
context.saved = false;
context._autoRestoreMonthlyInterestLoans();
assert.equal(context.borrowers[0].collectionDone, false, 'due borrower remains Active');

const renderSource = extractFunction('renderBorrowers');
assert.match(renderSource, /if\(tab==='schedule'\)return _miFlow\.bucket==='upcoming'/, 'Upcoming tab uses canonical monthly state');
assert.match(renderSource, /Current Interest Calculation/, 'Upcoming card displays live monthly calculation');
assert.match(renderSource, /_monthlyFlow\.nextDueDate\|\|_monthlyFlow\.dueDate/, 'Upcoming date uses canonical monthly state');
// Next Week/Next Month is a pure follow-up scheduling action, never a
// collection gate: it must never be blocked by a pending due (that guard was
// intentionally removed — see tests/next-week-no-pending-due-block.test.js).
const nextMonthSource = extractFunction('_apptNextWeekImpl');
assert.ok(!/monthlyFlow\.payableDue>0\.01/.test(nextMonthSource), 'Next Month no longer blocks on a pending due — scheduling is always permitted');

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'accrual-upcoming','live-current-calculation','exact-due-active','previous-pending-active',
    'partial-same-day-closed','partial-next-day-active','full-clear-upcoming',
    'principal-only-isolated','advance-paid-cycle-skip','single-tab-canonical-source',
    'next-month-never-blocks-on-pending-due'
  ]
}, null, 2));
