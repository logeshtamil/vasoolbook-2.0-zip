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
    const char = source[index], next = source[index + 1];
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

const areaDays = { W1:'Wednesday' };
const context = {
  Date, Math, Object, Array, String, Number, JSON, console, isFinite,
  entryLog: [],
  todayStr: () => '2026-08-12',
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly',
  borrowerWeeklyPayment: borrower => borrower.installment,
  _borrowerAreaDay: borrower => areaDays[borrower.id] || '',
  _dateOnly(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  },
  _isoDate(value) {
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  },
  _localCalendarOrdinal(value) {
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  },
  _cycleMonthDate(anchor, offset) {
    const [year, month, day] = String(anchor).slice(0, 10).split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1, 12, 0, 0, 0);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, last));
    return [target.getFullYear(), String(target.getMonth() + 1).padStart(2, '0'), String(target.getDate()).padStart(2, '0')].join('-');
  }
};
vm.createContext(context);
['paymentReminderPeriodLabel','_regularPaymentCompletedPendingSummary','_paymentReminderPendingText']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const weekly = { id:'W1', loanType:'weekly', loandate:'2026-07-09', loan:6000, period:10, installment:600 };
const weeklyRows = [
  { id:'W-P1', bid:'W1', date:'2026-07-15', today:600 },
  { id:'W-P2', bid:'W1', date:'2026-07-29', today:300 },
  { id:'W-P3', bid:'W1', date:'2026-08-05', today:300 }
];
let summary = context._regularPaymentCompletedPendingSummary(weekly, '2026-08-12', weeklyRows);
assert.equal(summary.completedCount, 4, 'only four completed weekly cycles exist at the boundary');
assert.equal(summary.pendingCount, 2, 'two completed weeks remain genuinely unpaid');
assert.equal(context._paymentReminderPendingText(weekly, '2026-08-12', weeklyRows), 'Your Payment is pending. Pending 2 Weeks Amount.');

const oneWeekRows = weeklyRows.concat({ id:'W-P4', bid:'W1', date:'2026-08-12', today:600 });
assert.equal(context._paymentReminderPendingText(weekly, '2026-08-12', oneWeekRows), 'Your Payment is pending. Pending 1 Week Amount.', 'singular Week is exact');
const beforeCurrentWeekEnds = weeklyRows.concat({ id:'W-ADV', bid:'W1', date:'2026-08-14', today:1200 });
summary = context._regularPaymentCompletedPendingSummary(weekly, '2026-08-18', beforeCurrentWeekEnds);
assert.equal(summary.completedCount, 4, 'current incomplete Wednesday cycle is excluded before 19-Aug');
assert.equal(summary.pendingCount, 0, 'advance money may clear completed weeks but cannot create/count the incomplete week');
assert.equal(context._paymentReminderPendingText(weekly, '2026-08-18', beforeCurrentWeekEnds), 'Your Payment is pending. Pending 0 Weeks Amount.');

const monthly = { id:'M1', loanType:'monthly', loandate:'2026-05-15', loan:6000, period:6, installment:1000 };
const monthlyRows = [
  { id:'M-P1', bid:'M1', date:'2026-06-15', today:1000 },
  { id:'M-P2', bid:'M1', date:'2026-07-20', today:500 },
  { id:'M-P2', bid:'M1', date:'2026-07-20', today:500 }
];
summary = context._regularPaymentCompletedPendingSummary(monthly, '2026-08-14', monthlyRows);
assert.equal(summary.completedCount, 2, 'May-Jun and Jun-Jul are completed; Jul-Aug is incomplete');
assert.equal(summary.pendingCount, 1, 'duplicate ID is counted once and leaves one partial completed month');
assert.equal(context._paymentReminderPendingText(monthly, '2026-08-14', monthlyRows), 'Your Payment is pending. Pending 1 Month Amount.');

const monthlyUnpaid = [{ id:'M-P1', bid:'M1', date:'2026-06-15', today:500 }];
assert.equal(context._paymentReminderPendingText(monthly, '2026-08-15', monthlyUnpaid), 'Your Payment is pending. Pending 3 Months Amount.', 'plural Months is exact after the next boundary');

const interest = { id:'I1', loanType:'weekly_interest', isInterest:true };
assert.equal(context._paymentReminderPendingText(interest, '2026-08-12', []), 'Your Payment is pending. Kindly request you to pay the "Week" Amount.', 'Interest Loan reminder wording is protected');

console.log(JSON.stringify({status:'PASS',checks:[
  'weekly-saved-history','weekly-partial','weekly-singular-plural','weekly-current-incomplete-excluded',
  'monthly-saved-history','monthly-duplicate-id','monthly-singular-plural','monthly-current-incomplete-excluded','interest-message-protected'
]}, null, 2));
