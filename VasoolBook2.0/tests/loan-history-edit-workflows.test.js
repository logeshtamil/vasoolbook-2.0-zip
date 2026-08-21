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

const elements = {
  m_loan_type: { value: 'monthly' },
  m_loandate: { value: '2026-01-31' },
  m_loanend: { value: '' },
  m_period: { value: '1' }
};
const context = {
  console,
  Date,
  Object,
  entryLog: [],
  borrowers: [],
  editingId: null,
  $id: id => elements[id] || null,
  fmtDate: value => value,
  paymentModeLabel: entry => entry.pay || '',
  paymentPurposeLabel: purpose => purpose || '',
  isInterestLoanType: type => String(type).includes('interest'),
  isMonthlyType: type => String(type).includes('month'),
  _interestBasePrincipal: borrower => Number(borrower.originalPrincipal || borrower.loan || 0)
};
vm.createContext(context);
[
  '_historySearchNormalize',
  '_historySearchMatchesNormalized',
  '_historySearchMatches',
  '_historyAmountSearchFields',
  '_historyPhoneSearchFields',
  '_historyEntrySearchFields',
  '_roundInterestDown10',
  '_regularLoanTerms',
  '_interestLoanPaidTotals',
  '_loanFormPrincipalAmount',
  'autoCalcEndDate'
].forEach(name => vm.runInContext(extractFunction(name), context));

assert.equal(context._historySearchNormalize('  ANIL-Kumar (Sulochana) '), 'anil kumar sulochana');
assert.equal(context._historySearchMatches('anil kum', ['ANIL KUMAR M', '9481304038']), true);
assert.equal(context._historySearchMatches('9481 88541', ['ANIL', '9481304038', '#88541']), true);
assert.equal(context._historySearchMatches('north cash', ['North Area', 'Cash (Full Close)']), true);
assert.equal(context._historySearchMatches('wrong person', ['ANIL KUMAR']), false);

const regular = context._regularLoanTerms({ loan: 6250, interestAmt: 1250, commission: 0 });
assert.deepEqual(
  JSON.parse(JSON.stringify(regular)),
  { loan: 6250, interest: 1250, netCash: 5000, commission: 250, noCommission: false }
);
assert.equal(context._regularLoanTerms({ loan: 6250, interestAmt: 1250, commission: 0, commissionSet: true }).commission, 0);
assert.equal(context._regularLoanTerms({ loan: 6250, interestAmt: 1250, commissionNo: true }).commission, 0);
assert.equal(context._regularLoanTerms({ loan: 6250, interestAmt: 0 }).interest, 1250);
assert.equal(context._regularLoanTerms({ loan: 6250, interestAmt: 0, _interestAmountManual: true }).interest, 0);

const interestBorrower = {
  id: 'L1',
  loan: 50000,
  originalPrincipal: 50000,
  remainingPrincipal: 40000,
  topups: [{ amount: 5000 }]
};
const paidTotals = context._interestLoanPaidTotals(interestBorrower, [
  { bid: 'L1', interestComponent: 3000, principalComponent: 5000 },
  { bid: 'L1', interestComponent: 2000, principalComponent: 5000 },
  { bid: 'L1', isTopUp: true, pay: 'Top-Up', interestComponent: 9999 }
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(paidTotals)),
  { principalPaid: 15000, interestPaid: 5000, totalPaid: 20000 }
);

context.editingId = 'L1';
context.borrowers = [interestBorrower];
assert.equal(context._loanFormPrincipalAmount(60000, 'monthly_interest'), 65000);
assert.equal(context._loanFormPrincipalAmount(6250, 'monthly'), 6250);

context.autoCalcEndDate();
assert.equal(elements.m_loanend.value, '2026-02-28', 'monthly end date clamps without UTC rollover');

assert.doesNotMatch(source, /id="m_name"[^>]*oninput="this\.value=this\.value\.toUpperCase/);
assert.doesNotMatch(source, /id="cem-name"[^>]*oninput="this\.value=this\.value\.toUpperCase/);
assert.match(source, /var newLoanBid=d\.bid\|\|_popBid/);
assert.match(source, /openNewLoanForCustomer\(newLoanBid\)/);
assert.match(source, /function markPaidAfterNewLoan\(\)[\s\S]*openNewLoanForCustomer\(bid\)/);
assert.match(source, /Principal Paid[\s\S]*Interest Paid/);
assert.match(source, /originalPrincipal:_isInterestType\?loan/);
assert.match(source, /interestBasePrincipalAtStart:_isInterestType\?_editedLockedPrincipalBase/);
assert.match(source, /currentLoanAmount:loan/);
assert.match(source, /keepNoCommission[\s\S]*_setCommissionToggle\(!keepNoCommission,true\)/);
assert.match(source, /Searching complete collection history/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'history-token-search',
    'history-phone-loan-id-search',
    'history-payment-filter-normalization',
    'fully-paid-new-loan-routing',
    'borrower-name-caret-safety',
    'regular-loan-6250-1250-5000',
    'commission-five-percent',
    'explicit-no-commission',
    'interest-principal-paid-total',
    'interest-paid-total',
    'interest-edit-topup-once',
    'monthly-date-clamp',
    'loan-edit-derived-state'
  ]
}, null, 2));
