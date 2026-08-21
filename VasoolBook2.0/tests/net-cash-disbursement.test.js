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
  _roundInterestDown10: value => Math.ceil((value - 1e-9) / 5) * 5,
  _reportIsOnlinePay: pay => /gpay|phonepe|paytm|online|upi|bank|neft|imps|rtgs/.test(String(pay).toLowerCase())
};
vm.createContext(context);
['_regularLoanTerms', '_loanNetCashDisbursed', '_loanIssueDisbursementSplit', '_reportLoanIssueSplit']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const sanctioned = {loan: 6250, interestAmt: 1250, loanPayType: 'Cash+GPay', loanIssueIsSplit: true, loanIssueCashAmt: 3000, loanIssueUpiAmt: 2000, netCashDisbursed: 5000};
assert.equal(context._loanNetCashDisbursed(sanctioned), 5000, 'principal remains 6250 but cash outflow is 5000');
assert.deepEqual(JSON.parse(JSON.stringify(context._reportLoanIssueSplit(sanctioned))), {cash:3000, bank:2000}, 'split payout totals exactly net cash');

const legacyFullSplit = {loan: 6250, interestAmt: 1250, loanPayType: 'Cash+GPay', loanIssueIsSplit: true, loanIssueCashAmt: 3750, loanIssueUpiAmt: 2500};
const legacyPayout = context._loanIssueDisbursementSplit(legacyFullSplit);
assert.equal(legacyPayout.total, 5000, 'legacy full-principal split is read as net cash without mutating loan principal');
assert.equal(legacyPayout.cash + legacyPayout.bank, 5000, 'legacy payout remains balanced');
assert.equal(legacyFullSplit.loan, 6250, 'legacy sanctioned principal is untouched');

assert.match(source, /Split Cash \+ UPI must equal Net Cash/);
assert.match(source, /netCashDisbursed:netCashDisbursed/);
assert.match(source, /var intLess\s+=\s+0;/);
assert.match(source, /function _reportLoanPayoutAfterDeductions\(b\)\{\s+return _loanNetCashDisbursed\(b\);/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'sanctioned-principal-preserved',
    'net-cash-split-validation',
    'legacy-split-safe-normalization',
    'no-double-due-deduction'
  ]
}, null, 2));
