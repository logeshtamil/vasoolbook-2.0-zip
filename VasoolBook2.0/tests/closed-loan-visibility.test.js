'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = {
  String,
  todayStr: () => '2026-08-09',
  _isClosedPaidOffLoan: borrower => !!borrower && borrower.paidOff === true
};
vm.createContext(context);
vm.runInContext(extractFunction('_isPermanentClosedVisibleOnDate'), context);

const closedToday = { id: 'loan-today', paidOff: true, closedDate: '2026-08-09' };
const closedYesterday = { id: 'loan-yesterday', paidOff: true, closedDate: '2026-08-08' };
const missingDate = { id: 'legacy-no-date', paidOff: true };
const temporary = { id: 'next-week', paidOff: false, closedDate: '2026-08-09' };

assert.equal(context._isPermanentClosedVisibleOnDate(closedToday, '2026-08-09'), true, 'paid-off loan remains visible for its full saved closing date');
assert.equal(context._isPermanentClosedVisibleOnDate(closedToday, '2026-08-10'), false, 'paid-off loan is hidden starting next calendar day');
assert.equal(context._isPermanentClosedVisibleOnDate(closedYesterday, '2026-08-09'), false, 'older closure never remains in normal Closed list');
assert.equal(context._isPermanentClosedVisibleOnDate(missingDate, '2026-08-09'), false, 'missing closedDate is not replaced with session/refresh time');
assert.equal(context._isPermanentClosedVisibleOnDate(temporary, '2026-08-09'), false, 'temporary waiting closure remains governed by its existing workflow');

assert.match(source, /if\(typeof _isClosedPaidOffLoan==='function'&&_isClosedPaidOffLoan\(b\)\)\{\s*return tab==='skip'/, 'permanent closures cannot leak into Active or Upcoming Due');
assert.match(source, /_isPermanentClosedVisibleOnDate\(b,today\)/, 'Closed visibility is based on saved closedDate and local calendar date');

console.log(JSON.stringify({
  status: 'PASS',
  checks: ['same-day-closed-visibility', 'next-day-hide', 'closedDate-only', 'temporary-closure-preserved', 'single-normal-tab']
}, null, 2));
