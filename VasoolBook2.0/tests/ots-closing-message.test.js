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
  let depth = 0, quote = '', escaped = false;
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

const context = {
  Object, Number, Math, isFinite,
  cfg: () => 'Money Lenders', todayStr: () => '2026-08-05',
  fmt: value => Number(value || 0).toLocaleString('en-IN'),
  fmtDate: value => String(value || ''),
  customerMessageText: value => value
};
vm.createContext(context);
['_otsShareData', '_otsClosingSnapshot', '_otsSharePayLine', 'buildOTSClosingText']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const data = {
  name: 'ANIL KUMAR', area: 'NEHRU NAGAR', oldLoanNo: '88541', dateVal: '2026-08-05',
  previousLoanAmount: 50000, totalClosureAmount: 2500, paidToday: 0,
  newLoanAmt: 18750, interestAmt: 3750, payVal: 'Cash'
};
const snapshot = context._otsClosingSnapshot(data);
assert.equal(snapshot.otsBalanceAdjustment, 2500);
assert.equal(snapshot.netLoanAmount, 15000);
assert.equal(snapshot.cashGiven, 12500);

const message = context.buildOTSClosingText(data);
assert.match(message, /Previous Loan Amount: Rs 50,000/);
assert.match(message, /Total Closure Amount: Rs 2,500/);
assert.match(message, /OTS Balance Adjustment: Rs 2,500/);
assert.match(message, /Net Loan Amount: Rs 15,000/);
assert.match(message, /Cash Given: Rs 12,500/);
assert.doesNotMatch(message, /Principal Balance|Adjusted Balance|Today Payment/);

const paidMessage = context.buildOTSClosingText(Object.assign({}, data, {paidToday: 500}));
assert.match(paidMessage, /Today Payment: Rs 500/);
assert.match(paidMessage, /OTS Balance Adjustment: Rs 2,000/);

const cardStart = source.indexOf('function _otsShareCardHTML(');
const cardEnd = source.indexOf('function showOTSShareResult(', cardStart);
const cardSource = source.slice(cardStart, cardEnd);
assert.match(cardSource, /Previous Loan Amount/);
assert.match(cardSource, /OTS Balance Adjustment/);
assert.doesNotMatch(cardSource, /Principal Balance|Adjusted Balance|OTS Balance Collection/);
assert.match(source, /navigator\.share\(\{files:\[file\]\}\)/);
assert.match(source, /var cashOnHand=netLoanAmt-adjOldBal;/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'previous-original-loan-amount',
    'exact-closure-and-adjustment',
    'net-loan-and-cash-given-formula',
    'zero-payment-omits-payment-line',
    'image-only-share'
  ]
}, null, 2));
