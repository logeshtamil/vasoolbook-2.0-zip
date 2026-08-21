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
  Object, Number, Math, isFinite, entryLog: [],
  _dateOnly: value => new Date(`${value}T12:00:00Z`),
  fmtDate: value => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [y,m,d] = String(value).split('-').map(Number);
    return `${String(d).padStart(2,'0')}-${months[m-1]}-${y}`;
  },
  paymentModeLabel: entry => entry.isSplit
    ? `Split (Cash ₹${entry.cashAmt} + ${entry.upiMethod} ₹${entry.upiAmt})`
    : entry.pay,
  paymentPurposeLabel: purpose => ({interest_principal:'Interest + Principal'})[purpose] || purpose,
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly_interest'
};
vm.createContext(context);
[
  '_savedInterestTransactionMessageSnapshot', '_interestRowsThroughPayment',
  '_savedPaymentSnapshot', '_messageLoanTypeLabel', '_interestMessagePrincipalSnapshot',
  '_interestDuePeriodSummary', '_interestSavedPaidCycles', '_interestPaymentMessageMeta',
  '_interestPaymentReceiptModel', '_interestPaymentReceiptLines',
  '_interestPaymentMessageLines', '_interestClosureMessageLines', '_txnTextLines'
].forEach(name => vm.runInContext(extractFunction(name), context));

const entry = Object.freeze({
  id:'TXN-100', bid:'IL-1', name:'ANIL KUMAR', area:'NEHRU NAGAR', loanno:'88541',
  date:'2026-07-30', today:27000, pay:'Split', isSplit:true, cashAmt:2000, upiAmt:25000, upiMethod:'GPay',
  loanType:'monthly_interest', effectiveLoanType:'monthly_interest', isInterestLoan:true,
  cyclePeriodStart:'2026-07-02', cyclePeriodEnd:'2026-07-30', cycleIndex:1,
  cycleInterest:2500, previousPending:500, totalDueAtPayment:3000,
  principalComponent:25000, interestComponent:2000,
  principalPaidAfter:25000, interestPaidAfter:2000,
  principalPendingAfter:25000, interestPendingAfter:500,
  paymentPurpose:'interest_principal', note:'Part payment', agentRemark:'Office collection'
});
const borrower = {id:'IL-1',name:'ANIL KUMAR',area:'NEHRU NAGAR',loanType:'monthly_interest',isInterest:true,remainingPrincipal:25000};

const saved = context._savedInterestTransactionMessageSnapshot(entry);
assert.equal(saved.paidAmount, 27000);
assert.equal(saved.principalPaid, 25000);
assert.equal(saved.interestPaid, 2000);
assert.equal(saved.currentLoanAmount, 25000);
assert.equal(saved.remarks, 'Part payment · Office collection · Interest + Principal');

const lines = context._txnTextLines({co:'Money Lenders',transaction:entry,b:borrower});
assert.ok(!lines.some(line => /Paid (Month|Week):/.test(line)));
const rangeIndex = lines.findIndex(line => line.includes('Cycle Period:'));
assert.equal(lines[rangeIndex + 1], '📑 Current Principal Amount: ₹25,000', 'uses final saved principal directly after the cycle period');
assert.ok(lines.includes('🏦 Principal Paid: ₹25,000'));
assert.ok(lines.includes('💸 Due Paid: ₹2,000'));
assert.ok(!lines.some(line => line.includes('Loan Type')));
assert.ok(!lines.some(line => line.includes('Current Loan Amount')));

const dueOnly = context._txnTextLines({co:'Money Lenders',transaction:Object.assign({},entry,{
  principalComponent:0, today:2000, principalPendingAfter:50000
}),b:Object.assign({},borrower,{remainingPrincipal:25000})});
assert.ok(!dueOnly.some(line => line.includes('Current Principal Amount')));
assert.ok(!dueOnly.some(line => line.includes('Due Paid')));

const weekly = context._txnTextLines({co:'Money Lenders',transaction:Object.assign({},entry,{
  effectiveLoanType:'weekly_interest', loanType:'weekly_interest',
  cyclePeriodStart:'2026-07-23', cyclePeriodEnd:'2026-07-30', cycleIndex:5,
  principalComponent:500, interestComponent:600, today:1100, principalPendingAfter:24500
}),b:Object.assign({},borrower,{loanType:'weekly_interest',remainingPrincipal:24500})});
assert.ok(weekly.includes('📑 Current Principal Amount: ₹24,500'));
assert.ok(!weekly.some(line => /Paid (Month|Week):/.test(line)));
assert.ok(!weekly.some(line => line.includes('Loan Type')));

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'immutable-latest-saved-record',
    'saved-payment-components',
    'paid-month-week-line-removed',
    'no-double-principal-reduction',
    'due-only-omits-principal-line',
    'weekly-monthly-format-consistency',
    'loan-type-line-removed'
  ]
}, null, 2));
