'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
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
  throw new Error(`unterminated ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext(extractFunction('_stampInterestCycleAllocationSource'), context);

const entry = {
  id: 'advance-original-1',
  date: '2026-07-15',
  cyclePayments: [{ idx: 2, start: '2026-08-01', end: '2026-09-01', amount: 10000 }]
};
assert.equal(context._stampInterestCycleAllocationSource(entry), true);
assert.equal(entry.date, '2026-07-15', 'original cash transaction date is unchanged');
assert.equal(entry.originalPaymentDate, '2026-07-15');
assert.deepEqual(entry.cyclePayments[0], {
  idx: 2,
  start: '2026-08-01',
  end: '2026-09-01',
  amount: 10000,
  paymentDate: '2026-07-15',
  originalPaymentDate: '2026-07-15',
  sourceTransactionId: 'advance-original-1'
});

const consume = extractFunction('_consumeAdvanceInterestCredit');
assert.ok(!/entryLog\.unshift\(/.test(consume), 'render-time legacy processing cannot create a duplicate collection row');
assert.match(consume, /sourceTransactionId:entry\.id/);
assert.match(consume, /paymentDate:originalDate/);
assert.match(consume, /originalPaymentDate:originalDate/);
assert.match(source, /_stampInterestCycleAllocationSource\(entry\);\s*entryLog\.unshift\(entry\)/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'future-cycle-keeps-original-payment-date',
    'future-cycle-links-original-transaction',
    'legacy-render-does-not-create-second-cash-entry',
    'new-save-stamps-cycle-source-before-history-write'
  ]
}, null, 2));
