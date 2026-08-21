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
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const borrower = { id: 'IL-DETAIL', isInterest: true };
let events = [];
const context = {
  Object,
  Number,
  Math,
  isFinite,
  _principalEvents: () => events.slice(),
  _principalAtDate: (b, date) => {
    let principal = 50000;
    events.forEach(event => { if (event.date <= date) principal += event.delta; });
    return principal;
  },
  _periodInterestGross: () => 2000,
  _daysBetween: (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000),
  fmtDate: value => {
    const [y,m,d] = value.split('-').map(Number);
    return `${String(d).padStart(2,'0')}-${monthNames[m-1]}-${y}`;
  }
};
vm.createContext(context);
vm.runInContext(extractFunction('_roundInterestDown10'), context);
vm.runInContext(extractFunction('_interestDueDetailsForMessage'), context);
vm.runInContext(extractFunction('_interestAmountMessageLines'), context);

let detail = context._interestDueDetailsForMessage(borrower, '2026-07-02', '2026-07-30', 2000, []);
assert.equal(detail.hasDetails, false, 'constant principal has no Due Details');
let lines = context._interestAmountMessageLines(borrower, '2026-07-02', '2026-07-30', 2000, [], 'Monthly Due Amount');
assert.deepEqual(Array.from(lines), ['Monthly Due Amount: ₹2,000'], 'constant principal shows only final interest');

events = [{ date: '2026-07-22', delta: -25000, type: 'principal' }];
detail = context._interestDueDetailsForMessage(borrower, '2026-07-02', '2026-07-30', 2000, events);
assert.equal(detail.hasDetails, true);
assert.equal(detail.rows.length, 2);
assert.deepEqual(Array.from(detail.rows.map(row => row.days)), [20, 8]);
assert.deepEqual(Array.from(detail.rows.map(row => row.principal)), [50000, 25000]);
assert.deepEqual(Array.from(detail.rows.map(row => row.interest)), [1670, 330]);
assert.equal(detail.rows.reduce((sum,row) => sum + row.days, 0), 28, 'days do not overlap');
assert.equal(detail.rows.reduce((sum,row) => sum + row.interest, 0), 2000, 'segment rounding equals final interest');
assert.ok(detail.lines.includes('02-Jul-2026 → 22-Jul-2026 | 20 days | ₹50,000 | Interest ₹1,670'));
assert.ok(detail.lines.includes('22-Jul-2026 → 30-Jul-2026 | 8 days | ₹25,000 | Interest ₹330'));
assert.equal(detail.lines[detail.lines.length - 1], 'Total Interest: ₹2,000');

events = [
  { date: '2026-07-02', delta: -5000, type: 'principal' },
  { date: '2026-07-30', delta: -5000, type: 'principal' }
];
detail = context._interestDueDetailsForMessage(borrower, '2026-07-02', '2026-07-30', 2000, events);
assert.equal(detail.hasDetails, false, 'boundary payments do not create zero-day or overlapping segments');

assert.ok(source.includes("_interestAmountMessageLines(b,_savedCycleStart,_savedCycleEnd,cycleDue,_messageRows,dueAmtLabel)"));
assert.ok(source.includes("_interestAmountMessageLines(b,cycleStart,cycleEnd,dueAmt,_logRows,dueAmtLabel2)"));
assert.ok(source.includes("_interestAmountMessageLines(row.borrower,row.periodStart,row.date,row.dueAmt,null,'Due Amount')"));
assert.ok(!source.includes("lines3.push('📋 Due Details:-')"), 'generic pending block no longer claims Due Details');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'constant-principal-single-amount',
    'principal-change-conditional-details',
    'saved-date-segments',
    'non-overlapping-days',
    'exact-rounding-total',
    'boundary-date-safety',
    'popup-history-reminder-integration'
  ]
}, null, 2));
