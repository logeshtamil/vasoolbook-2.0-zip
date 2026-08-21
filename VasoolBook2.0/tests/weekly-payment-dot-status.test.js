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

const context = {
  Date, Math, Object, Array, String, Number, JSON, console,
  todayStr: () => '2026-08-12',
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly',
  borrowerWeeklyPayment: borrower => borrower.installment,
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
  }
};
vm.createContext(context);
vm.runInContext(extractFunction('_weeklyPaymentDotStatuses'), context);

const borrower = { id:'W-1', loanType:'weekly', loandate:'2026-07-08', installment:600 };
const statuses = records => Array.from(context._weeklyPaymentDotStatuses(borrower, records, '2026-08-12', 'Wednesday', 5));

assert.deepEqual(statuses([]), ['red','red','red','red','red'], 'only the five completed Wednesday cycles are pending');
assert.deepEqual(statuses([
  { id:'P-1', bid:'W-1', date:'2026-07-09', today:600 },
  { id:'P-2', bid:'W-1', date:'2026-07-30', today:600 }
]), ['green','green','red','red','red'], 'late payments settle the oldest completed cycles from saved history');
assert.deepEqual(statuses([
  { id:'P-1', bid:'W-1', date:'2026-07-09', today:300 },
  { id:'P-2', bid:'W-1', date:'2026-07-15', today:300 }
]), ['green','red','red','red','red'], 'multiple partial saved payments combine into one paid cycle');
assert.deepEqual(statuses([
  { id:'ADV', bid:'W-1', date:'2026-07-09', today:1800 }
]), ['green','green','green','red','red'], 'one advance payment allocates chronologically without duplicate week counting');
assert.deepEqual(statuses([
  { id:'DUP', bid:'W-1', date:'2026-07-09', today:600 },
  { id:'DUP', bid:'W-1', date:'2026-07-09', today:600 }
]), ['green','red','red','red','red'], 'duplicate saved IDs are counted once');

const beforeBoundary = Array.from(context._weeklyPaymentDotStatuses(borrower, [
  { id:'CURRENT', bid:'W-1', date:'2026-08-11', today:3600 }
], '2026-08-11', 'Wednesday', 5));
const completedOnly = Array.from(context._weeklyPaymentDotStatuses(borrower, [
  { id:'SETTLED', bid:'W-1', date:'2026-08-11', today:3000 }
], '2026-08-11', 'Wednesday', 5));
assert.deepEqual(beforeBoundary, completedOnly, 'money for the incomplete current week cannot change a dot before its boundary');

const newBorrower = { id:'W-2', loanType:'weekly', loandate:'2026-08-10', installment:600 };
assert.deepEqual(Array.from(context._weeklyPaymentDotStatuses(newBorrower, [
  { id:'EARLY', bid:'W-2', date:'2026-08-10', today:600 }
], '2026-08-11', 'Wednesday', 5)), ['blank','blank','blank','blank','blank'], 'an incomplete first week remains not due even when paid early');

assert.deepEqual(Array.from(context._weeklyPaymentDotStatuses({ ...borrower, loanType:'monthly' }, [], '2026-08-12', 'Wednesday', 5)), [], 'non-weekly workflows are untouched');
assert.deepEqual(Array.from(context._weeklyPaymentDotStatuses({ id:'LEGACY', loanType:'weekly', installment:600 }, [
  { id:'OWN', bid:'LEGACY', date:'2026-08-01', today:600 },
  { id:'OTHER', bid:'OTHER', date:'2026-08-01', today:2400 }
], '2026-08-12', 'Wednesday', 5)), ['green','red','red','red','red'], 'legacy missing anchor is bounded to the visible window and ignores another borrower history');
assert.match(extractFunction('_weekDots'), /_weeklyPaymentDotStatuses\(b,bEntries,todayStr\(\),_areaDay\(b\),5\)/, 'weekly card uses canonical dot projection');

console.log(JSON.stringify({
  status:'PASS',
  checks:['completed-cycles-only','saved-history-oldest-first','partial-combine','advance-allocation','duplicate-id-protection','current-incomplete-excluded','new-loan-incomplete-blank','legacy-anchor-fallback','cross-borrower-isolation','weekly-only-scope']
}, null, 2));
