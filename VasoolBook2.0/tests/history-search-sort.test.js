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

const context = {
  console,
  Date,
  Math,
  isFinite,
  fmtDate: value => value === '2026-07-17' ? '17 Jul 2026' : value,
  paymentModeLabel: entry => entry.pay || '',
  paymentPurposeLabel: purpose => purpose || ''
};
vm.createContext(context);
[
  '_localCalendarParts',
  '_localCalendarOrdinal',
  '_historySearchNormalize',
  '_historySearchMatches',
  '_historySearchMatchesNormalized',
  '_historyAmountSearchFields',
  '_historyPhoneSearchFields',
  '_historyEntrySearchFields',
  '_historyEntrySortValue',
  '_historySortEntries'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id: 'B-88541',
  name: 'ANIL KUMAR M',
  phone: '9481304038',
  phone2: '9000011111',
  area: 'NEHRU NAGAR',
  loanno: '88541'
};
const entry = {
  id: 'E1',
  bid: borrower.id,
  name: 'ANIL KUMAR M',
  phone: borrower.phone,
  area: borrower.area,
  loanno: borrower.loanno,
  date: '2026-07-17',
  ts: '2026-07-17T14:30:00+05:30',
  today: 12500,
  total: 25000,
  balance: 37500,
  pay: 'Cash',
  paymentPurpose: 'regular',
  note: 'Part payment'
};
const fields = context._historyEntrySearchFields(entry, borrower);

[
  'anil ku',
  'kumar 9481',
  '948130',
  '+91 9481304038',
  '17/07/2026',
  '17-07-2026',
  '17 jul',
  '12,500',
  '₹12,500',
  '12500.00',
  '125',
  'nehru nag',
  '88541',
  'cash part'
].forEach(query => {
  assert.equal(context._historySearchMatches(query, fields), true, `matches ${query}`);
});
assert.equal(context._historySearchMatches('wrong borrower', fields), false);
assert.equal(context._historySearchMatches('12500 missing-area', fields), false);

const rows = [
  { id: 'middle', date: '2026-07-18', ts: '2020-01-01T08:00:00Z' },
  { id: 'old', date: '2026-07-17', ts: '2030-01-01T18:00:00Z' },
  { id: 'new', date: '2026-07-19', ts: '2019-01-01T06:00:00Z' }
];
assert.deepEqual(
  JSON.parse(JSON.stringify(context._historySortEntries(rows, 'newest').map(row => row.id))),
  ['new', 'middle', 'old'],
  'business date is authoritative for newest sort'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context._historySortEntries(rows, 'oldest').map(row => row.id))),
  ['old', 'middle', 'new'],
  'oldest sort reverses date order'
);

assert.match(source, /id="log-sort"[\s\S]*Newest to Oldest[\s\S]*Oldest to Newest/);
assert.match(source, /id="log-results-count"/);
assert.match(source, /const visibleList=list\.slice\(0,_logRenderLimit\)/);
assert.match(source, /function loadMoreLog\(\)/);
assert.match(source, /_historySearchMatchesNormalized\(_normalizedQ/);
assert.match(source, /#tab-log,#log-list\{touch-action:pan-y\}/);
assert.match(source, /function clearLogFilters\(\)[\s\S]*so\.value='newest'/);
assert.equal((source.match(/function renderLog\(/g) || []).length, 1, 'one renderLog definition');
assert.equal((source.match(/id="log-search"/g) || []).length, 1, 'one History search input');
assert.equal((source.match(/id="log-search"[^>]*oninput="scheduleRenderLog\(\)"/g) || []).length, 1, 'one History input handler');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'partial-name',
    'phone',
    'iso-and-display-date',
    'formatted-and-partial-amount',
    'area-and-loan-number',
    'multi-token-filter',
    'newest-default-sort',
    'oldest-sort',
    'business-date-authority',
    'bounded-rendering',
    'accurate-result-count-contract',
    'single-search-handler',
    'touch-scroll-contract'
  ]
}, null, 2));
