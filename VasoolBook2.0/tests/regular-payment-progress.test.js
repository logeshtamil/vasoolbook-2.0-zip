'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
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

const context = {
  Date, Math, Object, Array, String, Number, parseFloat, isFinite,
  todayStr: () => '2026-08-12',
  effectiveBorrowerLoanType: borrower => borrower.loanType,
  borrowerWeeklyPayment: borrower => borrower.installment,
  loanTypeDefaultPeriod: type => type === 'monthly' ? 6 : 10,
  _borrowerAreaDay: borrower => borrower.collectionDay,
  _dateOnly(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  },
  _isoDate(value) { return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-'); },
  _localCalendarOrdinal(value) {
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  },
  _cycleMonthDate(anchor, offset) {
    const [year, month, day] = String(anchor).slice(0, 10).split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1, 12, 0, 0, 0);
    target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    return [target.getFullYear(), String(target.getMonth() + 1).padStart(2, '0'), String(target.getDate()).padStart(2, '0')].join('-');
  }
};
vm.createContext(context);
['_regularPaymentCompletedPendingSummary', '_regularPaymentProgressLabel'].forEach(name => vm.runInContext(extractFunction(name), context));

const weekly = { id: 'W-1', loanType: 'weekly', loandate: '2026-07-08', loan: 6000, installment: 600, collectionDay: 'Wednesday' };
const weeklyRows = [
  { id: 'W-1', bid: 'W-1', date: '2026-07-09', today: 600 },
  { id: 'W-2', bid: 'W-1', date: '2026-07-16', today: 600 },
  { id: 'W-3', bid: 'W-1', date: '2026-07-23', today: 600 },
  { id: 'W-4', bid: 'W-1', date: '2026-07-30', today: 600 },
  { id: 'W-5', bid: 'W-1', date: '2026-08-06', today: 600 },
  { id: 'W-ADV', bid: 'W-1', date: '2026-08-11', today: 600 }
];
let summary = context._regularPaymentCompletedPendingSummary(weekly, '2026-08-11', weeklyRows);
assert.deepStrictEqual({ completed: summary.completedCount, paid: summary.paidCount, total: summary.totalPeriods, pending: summary.pendingCount }, { completed: 4, paid: 4, total: 10, pending: 0 }, 'current incomplete weekly payment is excluded');
assert.equal(context._regularPaymentProgressLabel(summary), '4 / 10 Weeks Paid');

summary = context._regularPaymentCompletedPendingSummary(weekly, '2026-08-12', weeklyRows);
assert.deepStrictEqual({ completed: summary.completedCount, paid: summary.paidCount, total: summary.totalPeriods, pending: summary.pendingCount }, { completed: 5, paid: 5, total: 10, pending: 0 }, 'saved cycle payment becomes paid only after the weekly boundary');
summary = context._regularPaymentCompletedPendingSummary(weekly, '2026-08-12', weeklyRows.slice(0, 4));
assert.deepStrictEqual({ paid: summary.paidCount, pending: summary.pendingCount }, { paid: 4, pending: 1 }, 'delete/edit immediately rebuilds progress from saved rows');

const monthly = { id: 'M-1', loanType: 'monthly', loandate: '2026-05-15', loan: 6000, installment: 1000 };
const monthlyRows = [
  { id: 'M-1', bid: 'M-1', date: '2026-06-15', today: 1000 },
  { id: 'M-2', bid: 'M-1', date: '2026-07-15', today: 1000 },
  { id: 'M-ADV', bid: 'M-1', date: '2026-08-10', today: 1000 }
];
summary = context._regularPaymentCompletedPendingSummary(monthly, '2026-08-14', monthlyRows);
assert.deepStrictEqual({ completed: summary.completedCount, paid: summary.paidCount, total: summary.totalPeriods, pending: summary.pendingCount }, { completed: 2, paid: 2, total: 6, pending: 0 }, 'current incomplete month is excluded');
assert.equal(context._regularPaymentProgressLabel(summary), '2 / 6 Months Paid');
summary = context._regularPaymentCompletedPendingSummary(monthly, '2026-08-15', monthlyRows);
assert.deepStrictEqual({ completed: summary.completedCount, paid: summary.paidCount, pending: summary.pendingCount }, { completed: 3, paid: 3, pending: 0 }, 'saved advance payment applies when the monthly cycle completes');

assert.match(source, /_regularPaymentCompletedPendingSummary\(b,todayStr\(\),bEntries\)/, 'borrower card reads the canonical completed-cycle ledger');
assert.match(source, /_regularProgressRow/, 'Info reads the canonical progress row');
assert.match(source, /_monthlyProgress=_regularPaymentCompletedPendingSummary/, 'monthly dots read the canonical completed-cycle ledger');
assert.match(source, /_dotsCacheInvalidate\(\)/, 'save paths invalidate dot rendering after payment changes');

console.log('Regular Weekly/Monthly payment progress tests passed.');
