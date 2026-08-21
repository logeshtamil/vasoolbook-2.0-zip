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

const context = {
  console,
  Object,
  Math,
  isFinite,
  cfg: key => key === 'monthly_period' ? '6' : key === 'weekly_period' ? '10' : '0',
  fmt: value => `₹${Number(value || 0).toLocaleString('en-IN')}`
};
vm.createContext(context);
[
  '_roundInterestDown10','isInterestLoanType','isMonthlyType','effectiveBorrowerLoanType','loanTypeDefaultPeriod',
  'loanTypeDisplayLabel','calcWeeklyPaymentAmount','_regularLoanTerms','borrowerWeeklyPayment',
  '_loanInfoEffectiveType','loanInfoTermsSnapshot','_loanInfoFinancialRows'
].forEach(name => vm.runInContext(extractFunction(name), context));

const weekly = context.loanInfoTermsSnapshot({
  loanType: 'weekly', loan: 6250, interestAmt: 1250, commission: 250,
  commissionSet: true, billingAmt: 625, period: 10
});
assert.deepEqual(JSON.parse(JSON.stringify(weekly)), {
  loanType: 'weekly', loanTypeLabel: 'Weekly Payment', isInterest: false, isMonthly: false,
  unit: 'Week', period: 10, periodLabel: 'Total Week Installments',
  installmentLabel: 'Week Installment Amount', loanAmount: 6250, interestAmount: 1250,
  interestRate: 20, interestRateLabel: '20% total', documentFee: 250,
  netLoanAmount: 5000, installmentAmount: 625
});

const monthly = context.loanInfoTermsSnapshot({
  loanType: 'monthly_payment', loan: 12000, interestAmt: 2400, commission: 480,
  commissionSet: true, billingAmt: 2000, period: 6
});
assert.equal(monthly.loanType, 'monthly');
assert.equal(monthly.loanTypeLabel, 'Monthly Payment');
assert.equal(monthly.periodLabel, 'Total Month Installments');
assert.equal(monthly.installmentLabel, 'Month Installment Amount');
assert.equal(monthly.netLoanAmount, 9600);
assert.equal(monthly.installmentAmount, 2000);

const interest = context.loanInfoTermsSnapshot({
  loanType: 'monthly_interest', isInterest: true, loan: 50000, principalAmt: 50000,
  interestRate: 5, interestAmt: 2500, period: 12, billingAmt: 0
});
assert.equal(interest.loanTypeLabel, 'Monthly Interest');
assert.equal(interest.interestAmount, 2500);
assert.equal(interest.interestRateLabel, '5% per month');
assert.equal(interest.netLoanAmount, 50000);
assert.equal(interest.documentFee, 0);
assert.equal(interest.period, 12);

const legacy = context.loanInfoTermsSnapshot({
  loanType: '', frequency: 'monthly', isInterest: false, loan: 10000,
  interestAmt: 2000, docFee: 300, billingAmt: 1600, period: 5
});
assert.equal(legacy.loanType, 'monthly');
assert.equal(legacy.documentFee, 300);
assert.equal(legacy.installmentAmount, 1600);

const rows = JSON.parse(JSON.stringify(context._loanInfoFinancialRows(weekly)));
['Loan Type','Due Amount','Interest Rate','Document Fee','Net Loan Amount','Week Installment Amount','Total Week Installments'].forEach(label => {
  assert.ok(rows.some(row => row[0] === label), `${label} row exists`);
});
assert.match(source, /const _infoTerms=loanInfoTermsSnapshot\(b\)/);
assert.equal((source.match(/_loanInfoFinancialRows\(_infoTerms\)/g) || []).length, 2, 'active and closed Info views share one terms snapshot');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'weekly-type-and-terms',
    'monthly-type-alias',
    'interest-amount-and-rate',
    'document-fee-fallback',
    'net-loan-source',
    'saved-installment-source',
    'week-month-installment-count',
    'legacy-monthly-detection',
    'active-closed-info-alignment'
  ]
}, null, 2));
