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

function element(value = '') {
  return {
    value,
    textContent: '',
    innerHTML: '',
    readOnly: false,
    style: {},
    dataset: {},
    parentElement: { style: {} }
  };
}

const elements = {
  m_loan_type: element('weekly'),
  m_period_unit: element(),
  m_period: element('10'),
  m_interest_panel: element(),
  m_int_extra_fields: element(),
  m_loan_security_section: element(),
  m_interest_amt_manual: element('999'),
  m_interest_amount_label: element(),
  m_weekly_pay: element('999'),
  m_pay_calc_lbl: element(),
  m_default_pay: element('999'),
  m_interest_rate: element('9'),
  m_int_calc_start: element('2026-02-15'),
  m_prev_pending_interest: element('500'),
  m_commission: element('75'),
  m_comm_yes_btn: element(),
  m_comm_no_btn: element(),
  m_commission_toggle_wrap: element(),
  m_commission_amount_wrap: element(),
  m_regular_terms_row: element(),
  m_payment_amount_row: element(),
  m_loan_security_type: element('secured'),
  m_loan_docs_wrap: element(),
  m_loan_doc_entries: element(),
  m_loandate: element('2026-01-31'),
  m_loanend: element(),
  m_loan: element('10000'),
  m_commission_info: element(),
  m_comm_calc: element(),
  m_comm_refund_badge: element(),
  m_principal_disp: element(),
  m_interest_amt: element(),
  m_total_with_interest: element(),
  m_billing_preview: element(),
  m_net_loan_disp: element()
};

elements.m_loan_type.dataset.appliedLoanType = 'weekly';
elements.m_interest_amt_manual.dataset.userSet = '1';
elements.m_weekly_pay.dataset.userSet = '1';
elements.m_default_pay.dataset.userSet = '1';
elements.m_interest_rate.dataset.userSet = '1';
elements.m_prev_pending_interest.dataset.userSet = '1';
elements.m_commission.dataset.userSet = '1';

let calcCalls = 0;
let dateCalls = 0;
const context = {
  console,
  Date,
  Object,
  Math,
  borrowers: [],
  editingId: null,
  _currentLoanType: 'weekly',
  $id: id => elements[id] || null,
  cfg: key => ({
    weekly_period: '10',
    monthly_period: '6',
    interest_weekly: '2',
    interest_monthly: '5'
  })[key] || '',
  fmt: n => String(n),
  document: { querySelectorAll: () => [] },
  calcCommission: () => { calcCalls += 1; },
  autoCalcEndDate: () => { dateCalls += 1; }
};
vm.createContext(context);
[
  '_roundInterestDown10',
  'isInterestLoanType',
  'isMonthlyType',
  'effectiveBorrowerLoanType',
  'isBorrowerMonthlyType',
  'loanTypeDefaultPeriod',
  'loanTypeDisplayLabel',
  'loanTypeFamily',
  'getDefaultInterestRate',
  '_setCommissionToggle',
  'onLoanTypeChange',
  'calcWeeklyPaymentAmount'
].forEach(name => vm.runInContext(extractFunction(name), context));

elements.m_loan_type.value = 'monthly';
context.onLoanTypeChange();
assert.equal(elements.m_period.value, 6, 'monthly switch resets to monthly period');
assert.equal(elements.m_period_unit.textContent, '(months)');
assert.equal(elements.m_interest_amt_manual.dataset.userSet, undefined);
assert.equal(elements.m_prev_pending_interest.value, '');
assert.equal(elements.m_default_pay.parentElement.style.display, '');
assert.equal(calcCalls, 1, 'loan-type transition performs one calculation refresh');
assert.equal(dateCalls, 1, 'loan-type transition performs one date refresh');

elements.m_loan_type.value = 'monthly_interest';
context.onLoanTypeChange();
assert.equal(elements.m_period.value, 6);
assert.equal(elements.m_interest_rate.value, 5);
assert.equal(elements.m_int_calc_start.value, '2026-01-31');
assert.equal(elements.m_interest_amt_manual.readOnly, true);
assert.equal(elements.m_weekly_pay.readOnly, true);
assert.equal(elements.m_default_pay.parentElement.style.display, 'none');
assert.match(elements.m_pay_calc_lbl.innerHTML, /Monthly Interest/);

elements.m_loan_type.value = 'weekly';
context.onLoanTypeChange();
assert.equal(elements.m_period.value, 10);
assert.equal(elements.m_period_unit.textContent, '(weeks)');
assert.equal(elements.m_interest_amt_manual.readOnly, false);
assert.equal(elements.m_weekly_pay.readOnly, false);
assert.equal(elements.m_default_pay.parentElement.style.display, '');

assert.equal(context.calcWeeklyPaymentAmount(10000, 10), 1000);
assert.equal(context.calcWeeklyPaymentAmount(10000, 6), 1667);

const npaMonthlyInterest = {
  loanType: 'npa',
  npaOriginalLoanType: 'monthly_interest',
  isInterest: true
};
assert.equal(context.effectiveBorrowerLoanType(npaMonthlyInterest), 'monthly_interest');
assert.equal(context.isBorrowerMonthlyType(npaMonthlyInterest), true);
assert.equal(context.loanTypeFamily('npa', npaMonthlyInterest), 'interest');
assert.equal(context.loanTypeDisplayLabel('npa', npaMonthlyInterest), 'NPA Account');

context._regularLoanTerms = borrower => ({
  loan: Number(borrower.loan || 0),
  interest: Number(borrower.interestAmt || 0),
  netCash: Number(borrower.loan || 0) - Number(borrower.interestAmt || 0),
  commission: Math.round((Number(borrower.loan || 0) - Number(borrower.interestAmt || 0)) * 0.05)
});
context._loanFormPrincipalAmount = amount => Number(amount || 0);
context.calcDefaultPaymentAmount = amount => Math.round(Number(amount || 0) / 10);
context.calcInterestPreview = () => {};
context._updateNetLoanStrip = () => {};
vm.runInContext(extractFunction('calcCommission'), context);

elements.m_loan_type.value = 'monthly';
elements.m_period.value = '6';
elements.m_loan.value = '10000';
elements.m_interest_amt_manual.value = '0';
delete elements.m_interest_amt_manual.dataset.userSet;
delete elements.m_weekly_pay.dataset.userSet;
delete elements.m_default_pay.dataset.userSet;
delete elements.m_commission.dataset.userSet;
elements.m_comm_no_btn.dataset.active = '0';
context.calcCommission();
assert.equal(elements.m_weekly_pay.value, 1667, 'monthly scheduled payment uses selected term');
assert.match(elements.m_pay_calc_lbl.innerHTML, /Monthly Payment/);

assert.match(source, /principalComponent:principalComp,interestComponent:interestComp/);
assert.match(source, /effectiveLoanType:effectiveBorrowerLoanType\(b\)/);
assert.match(source, /npaOriginalLoanType/);
assert.match(source, /Loan type cannot change after payments/);
assert.doesNotMatch(source, /function setLoanType\([^)]*\)[\s\S]{0,500}lt-weekly/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'weekly-transition',
    'monthly-transition',
    'weekly-interest-transition',
    'monthly-interest-transition',
    'npa-original-cycle',
    'stale-field-reset',
    'single-targeted-refresh',
    'selected-period-payment',
    'history-financial-split',
    'unsafe-edit-guard',
    'backup-type-metadata'
  ]
}, null, 2));
