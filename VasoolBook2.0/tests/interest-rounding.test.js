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
  _daysBetween: (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000),
  _principalAtDate: () => 60520,
  _principalEvents: () => [],
  _cycleIndexAt: () => 1,
  _nthCycleStart: () => '2026-07-01',
  _nthCycleEnd: () => '2026-07-31'
};
vm.createContext(context);
[
  '_roundInterestDown10','_periodInterestGross','_interestProratedThroughDate',
  '_topUpInterestSplit'
].forEach(name => vm.runInContext(extractFunction(name), context));

assert.equal(context._roundInterestDown10(3021), 3025);
assert.equal(context._roundInterestDown10(3025), 3025);
assert.equal(context._roundInterestDown10(3026), 3030);
assert.equal(context._roundInterestDown10(3029.99), 3030);
assert.equal(context._roundInterestDown10(3020), 3020);
assert.equal(context._roundInterestDown10(9), 10);
assert.equal(context._roundInterestDown10(-12), 0);

const borrower = {id:'IL-R10',isInterest:true,interestRate:5};
assert.equal(
  context._periodInterestGross(borrower,'2026-07-01','2026-07-31',[]),
  3030,
  'completed cycle due floors ₹3,026 to ₹3,020'
);
assert.equal(
  context._interestProratedThroughDate(borrower,'2026-07-01','2026-07-31','2026-07-31',[]),
  3030,
  'closure accrual uses the same floor'
);

context._principalAtDate = () => 50000;
const topup = context._topUpInterestSplit(borrower,'2026-07-21',10000);
assert.equal(topup.interestBefore % 5, 0);
assert.equal(topup.interestAfter % 5, 0);
assert.equal(topup.combinedInterest % 5, 0);
assert.equal(topup.interestBefore + topup.interestAfter, topup.combinedInterest);

[
  '_periodInterestGross(b,start,due,records)',
  '_interestProratedThroughDate(b,start,end,through,records)',
  '_roundInterestDown10(principalAmt*interestRate2/100)',
  '_roundInterestDown10(principal*rate/100)',
  '_roundInterestDown10(loan*0.20)',
  '_roundInterestDown10(newLoan*0.20)'
].forEach(fragment => assert.ok(source.includes(fragment), `${fragment} is integrated`));

[
  '_interestDueReminderMessage','_interestPaymentMessageLines','_interestClosureMessageLines',
  '_buildTopUpMsg','_interestPreClosureIntimationMessage','buildLoanSanctionMessage'
].forEach(name => assert.ok(!/round(?:ed|ing)/i.test(extractFunction(name)), `${name} has no rounding note`));

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'ceil-nearest-five','cycle-due','prorated-closure',
    'topup-segment-sum','loan-save-preview','report-calculation','no-message-note'
  ]
}, null, 2));
