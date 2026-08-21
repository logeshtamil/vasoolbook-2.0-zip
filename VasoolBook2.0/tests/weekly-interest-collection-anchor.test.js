'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const context = {
  Date, Math, Object, Array, String, Number, JSON, console,
  entryLog: [],
  todayStr: () => '2026-07-10',
  fmtDateWithWeekday: value => value,
  isBorrowerMonthlyType: borrower => /monthly/.test(String(borrower && borrower.loanType || '')),
  _isRegularMonthlyLoan: () => false,
  _borrowerAreaDay: borrower => ({ 'AREA-FRI': 'Friday', 'AREA-MON': 'Monday' })[borrower && borrower.areaId] || '',
  _cycleMonthDate: () => { throw new Error('monthly cycle path must not run'); },
  _roundInterestDown10: value => Math.ceil(((Number(value) || 0) - 1e-9) / 5) * 5,
  fmtDate: value => value,
  fmt: value => String(value)
};
context._principalEvents = function (borrower, records) {
  const rows = Array.isArray(records) ? records : context.entryLog;
  const events = (borrower.topups || []).map(item => ({ date:item.date, delta:Number(item.amount) || 0, type:'topup' }));
  rows.filter(entry => entry.bid === borrower.id && Number(entry.principalComponent) > 0)
    .forEach(entry => events.push({ date:entry.date, delta:-Number(entry.principalComponent), type:'principal' }));
  return events.sort((left, right) => left.date.localeCompare(right.date));
};
context._principalAtDate = function (borrower, date, records) {
  let principal = Number(borrower.originalPrincipal || borrower.principalAmt || borrower.loan || 0);
  context._principalEvents(borrower, records).forEach(event => { if (event.date <= date) principal += event.delta; });
  return Math.max(0, principal);
};
vm.createContext(context);
[
  '_localCalendarParts','_localCalendarString','_localCalendarOrdinal','_isoDate','_dateOnly','_daysBetween','_interestAccrualStartDate','_isWeeklyInterestLoan',
  '_weeklyInterestFirstCollectionDue','_interestCycleBillingDays','_nthCycleEnd','_nthCycleStart',
  '_cycleIndexAt','_nextCycleDateAfter','_borrowerNextAreaCollectionDate',
  '_borrowerNextReopenAfterPayment','_borrowerNextReopenAfterPaymentLabel',
  '_borrowerOwnCollectionCycleStart','_borrowerNextWeekReopenDate',
  '_periodInterestGross','_periodInterestAccrued',
  '_interestEntriesChrono','_applySavedInterestCyclePayment','_interestCycleAllocationProjection',
  '_interestCycleId','_interestCycleAllocationForPayment','_topUpInterestSplit','_weeklyInterestDueState'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id:'W-1', areaId:'AREA-FRI', isInterest:true, loanType:'weekly_interest',
  loandate:'2026-07-07', originalLoanDate:'2026-07-07', originalPrincipal:7000,
  principalAmt:7000, remainingPrincipal:7000, interestRate:7, topups:[]
};

assert.equal(context._weeklyInterestFirstCollectionDue(borrower), '2026-07-10', 'first own collection day anchors the loan');
assert.equal(context._nthCycleStart(borrower, 1), '2026-07-07');
assert.equal(context._nthCycleEnd(borrower, 1), '2026-07-10');
assert.equal(context._nthCycleStart(borrower, 2), '2026-07-10');
assert.equal(context._nthCycleEnd(borrower, 2), '2026-07-17');
assert.equal(context._nthCycleEnd(borrower, 3), '2026-07-24');
assert.equal(context._nthCycleEnd(borrower, 4), '2026-07-31');
assert.equal(context._cycleIndexAt(borrower, '2026-07-10'), 1, 'collection boundary belongs to the due cycle');
assert.equal(context._cycleIndexAt(borrower, '2026-07-11'), 2);
assert.equal(context._cycleIndexAt(borrower, '2026-07-17'), 2);
assert.equal(context._nextCycleDateAfter(borrower, '2026-07-07'), '2026-07-10');
assert.equal(context._nextCycleDateAfter(borrower, '2026-07-10'), '2026-07-17');
assert.equal(context._borrowerNextReopenAfterPayment(borrower, '2026-07-10'), '2026-07-17', 'collection-day payment cannot reopen on the same day');
assert.equal(context._borrowerNextReopenAfterPayment(borrower, '2026-07-11'), '2026-07-17', 'mid-cycle payment returns to the same canonical boundary');
assert.equal(context._borrowerNextWeekReopenDate(borrower, '2026-07-10'), '2026-07-17', 'Next Week advances exactly one own-area cycle');

assert.equal(context._interestCycleBillingDays(borrower, '2026-07-07', '2026-07-10'), 7);
assert.equal(context._periodInterestGross(borrower, '2026-07-07', '2026-07-10'), 210, 'three-day opening due is prorated over seven days');
assert.equal(context._periodInterestAccrued(borrower, '2026-07-07', '2026-07-08', '2026-07-10'), 70);
assert.equal(context._periodInterestGross(borrower, '2026-07-10', '2026-07-17'), 490, 'later cycles remain full seven-day cycles');

let allocation = context._interestCycleAllocationForPayment(borrower, 700, '2026-07-08');
assert.deepEqual(Array.from(allocation.payments, item => [item.idx,item.start,item.end,item.amount,item.paymentDate]), [
  [1,'2026-07-07','2026-07-10',210,'2026-07-08'],
  [2,'2026-07-10','2026-07-17',490,'2026-07-08']
], 'advance payment retains its date and allocates by anchored cycle');

allocation = context._interestCycleAllocationForPayment(borrower, 100, '2026-07-10');
assert.deepEqual(Array.from(allocation.payments, item => [item.idx,item.amount,item.pendingAfter]), [[1,100,110]], 'partial due stays linked to the opening cycle');

const topup = context._topUpInterestSplit(borrower, '2026-07-08', 7000);
assert.deepEqual({ start:topup.cycleStart, due:topup.dueDate, actualDays:topup.cycleDays, billingDays:topup.billingDays, dueAmount:topup.combinedInterest }, {
  start:'2026-07-07', due:'2026-07-10', actualDays:3, billingDays:7, dueAmount:350
}, 'top-up changes principal inside the anchored cycle without resetting its due date');

const legacyEntry = {
  id:'OLD-PAY', bid:borrower.id, date:'2026-07-14', interestComponent:490,
  cyclePayments:[{ idx:1, start:'2026-07-07', end:'2026-07-14', amount:490, paymentDate:'2026-07-14' }]
};
context.entryLog = [legacyEntry];
const immutableBefore = JSON.stringify(legacyEntry);
const migratedProjection = context._interestCycleAllocationProjection(borrower, 0, '2026-07-15');
assert.deepEqual(Array.from(migratedProjection.cycles.slice(0,2), cycle => [cycle.idx,cycle.gross,cycle.paid,cycle.pending]), [
  [1,210,210,0], [2,490,280,210]
], 'legacy excess carries forward instead of being discarded');
assert.equal(JSON.stringify(legacyEntry), immutableBefore, 'legacy payment record remains byte-for-byte unchanged');

context.getInterestCycleCalculation = (_borrower, date) => ({ dueDate:'2026-07-10', totalDue:210, pendingCycleCount:date >= '2026-07-10' ? 1 : 0 });
assert.equal(context._weeklyInterestDueState(borrower, '2026-07-09').isDue, false, 'loan is Upcoming before collection day');
assert.equal(context._weeklyInterestDueState(borrower, '2026-07-10').isDue, true, 'loan becomes due on collection day');

const originalTimezone = process.env.TZ;
for (const timezone of ['Asia/Kolkata','America/New_York','Pacific/Auckland']) {
  process.env.TZ = timezone;
  assert.equal(context._weeklyInterestFirstCollectionDue(borrower), '2026-07-10', `date-only anchor is stable in ${timezone}`);
}
process.env.TZ = originalTimezone;

const saveTopUpSource = extractFunction('saveTopUp');
assert.doesNotMatch(saveTopUpSource, /b\.interestCalcStart\s*=/, 'top-up never resets the cycle anchor');
assert.match(extractFunction('_proceedSaveEntryNextCycle'), /_borrowerNextReopenAfterPayment\(cur,dateVal\)/, 'advance-cycle save closes until the next canonical boundary');
assert.match(extractFunction('ignoreBorrower'), /_borrowerNextReopenAfterPayment\(b,todayStr\(\)\)/, 'skip cannot reopen during the same Collection Day');
assert.match(source, /var _wiState=_weeklyInterestDueState\(b,today\)/, 'borrower tabs use the canonical weekly due gate');
assert.match(source, /var collectionDay=.*_borrowerAreaDay/, 'interest cache includes collection-day changes');

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'first-own-collection-day-anchor','three-day-prorated-opening-cycle','strict-seven-day-cycles',
    'boundary-indexing','topup-does-not-reanchor','partial-cycle-allocation','advance-original-date',
    'legacy-payment-immutable','legacy-excess-spill-forward','upcoming-before-due','active-on-due',
    'post-payment-strict-next-boundary','skip-strict-next-boundary','next-week-single-cycle',
    'timezone-date-only','collection-day-cache-key'
  ]
}, null, 2));
