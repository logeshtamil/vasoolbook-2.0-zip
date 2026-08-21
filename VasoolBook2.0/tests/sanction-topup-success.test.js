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
  Number, Math,
  cfg: () => 'Money Lenders',
  fmtDate: value => String(value || ''),
  customerMessageText: value => value,
  _tuPayLabel: value => value.pay || 'Cash',
  _roundInterestDown10: value => value
};
vm.createContext(context);
['_topupDueAmount', '_buildTopUpMsg'].forEach(name => vm.runInContext(extractFunction(name), context));

const message = context._buildTopUpMsg({
  name: 'ANIL KUMAR', area: 'NEHRU NAGAR', loanno: '88541',
  isMonthly: true, period: 6, prevLoan: 50000, topupAmt: 10000,
  topupDate: '2026-08-05', pay: 'Cash', newLoan: 60000,
  currentDueBeforeTopUp: 2500, interest: 3000, dueDate: '2026-09-02'
});
assert.match(message, /Previous Principal : ₹50,000/);
assert.match(message, /Top-Up Amount      : ₹10,000/);
assert.match(message, /Updated Loan Amount : ₹60,000/);
assert.match(message, /Period              : Monthly · 6 Month\(s\)/);
assert.match(message, /Current Due Amount  : ₹2,500/);
assert.match(message, /Updated Due Amount : ₹3,000/);

const saveTopUp = extractFunction('saveTopUp');
assert.match(saveTopUp, /currentDueBeforeTopUp/);
assert.match(saveTopUp, /if\(_isEditSave\)\{_topupShareData=null;_topupProcessingStatus='success';return true;\}/);
assert.match(saveTopUp, /currentDueBeforeTopUp:currentDueBeforeTopUp/);
assert.match(saveTopUp, /period:\s+b\.period\|\|0/);
assert.match(source, /Loan Sanction Document/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'topup-success-message-details',
    'topup-current-and-updated-due',
    'topup-edit-skips-success-popup',
    'loan-sanction-info-access'
  ]
}, null, 2));
