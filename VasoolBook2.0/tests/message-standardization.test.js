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

const icon = code => String.fromCodePoint(code);
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function boldUnicode(text) {
  return String(text || '').replace(/[A-Za-z]/g, ch => {
    const code = ch.charCodeAt(0);
    return String.fromCodePoint(code >= 65 && code <= 90 ? 0x1D400 + (code - 65) : 0x1D41A + (code - 97));
  });
}
const context = {
  Object, Number, Math, isFinite, entryLog: [],
  cfg: key => key === 'company' ? 'Money Lenders' : '',
  todayStr: () => '2026-07-30',
  fmtDate: value => {
    const [y,m,d] = String(value || '').slice(0,10).split('-').map(Number);
    return value ? `${String(d).padStart(2,'0')}-${months[m-1]}-${y}` : '—';
  },
  fmtDateSlash: value => {
    const [y,m,d] = String(value || '').slice(0,10).split('-').map(Number);
    return value ? `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}` : '';
  },
  isBorrowerMonthlyType: borrower => String(borrower.loanType || '').includes('monthly'),
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly_interest',
  paymentModeLabel: entry => entry.pay || 'Cash',
  applyMessageTemplate: (type, message) => message,
  customerMessageText: message => message,
  getInterestCycleCalculation: () => ({
    calculationVersion: 1,
    cycleStart: '2026-07-02', cycleEnd: '2026-07-30',
    currentDue: 2500, previousPendingDue: 2500, totalDue: 5000
  })
};
vm.createContext(context);
[
  '_interestRowsThroughPayment', '_savedPaymentSnapshot', '_messageLoanTypeLabel',
  '_interestMessagePrincipalSnapshot', '_interestDuePeriodSummary',
  '_interestSavedPaidCycles',
  '_interestPaymentMessageMeta', '_interestPaymentReceiptModel',
  '_interestPaymentReceiptLines', '_interestPaymentMessageLines',
  'paymentReminderPeriodLabel', '_regularPaymentCompletedPendingSummary', '_paymentReminderPendingText',
  '_interestClosureMessageLines', '_messageBoldUnicode', '_monthlyInterestPayableSummary', '_interestDueReminderMessage'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id:'IL-MSG', name:'ANIL KUMAR', area:'NEHRU NAGAR', loanType:'monthly_interest',
  isInterest:true, principalAmt:50000, loan:50000, remainingPrincipal:50000
};
const cycles = [
  {idx:1,start:'2026-06-02',end:'2026-07-02',gross:2500,pending:2500},
  {idx:2,start:'2026-07-02',end:'2026-07-30',gross:2500,pending:2500}
];
// _interestDueReminderMessage: new clean format (bold-Unicode name/area/
// heading/closing, plain values, single combined Due Amount, no "Current
// Principal Amount" line, no "Your Payment is pending..." wording at all).
const reminder = context._interestDueReminderMessage(borrower, {totalDue:5000,cycles}).split('\n');
assert.deepStrictEqual(reminder, [
  '👤 '+boldUnicode('ANIL KUMAR')+',',
  '📍 '+boldUnicode('NEHRU NAGAR'),
  '',
  '📢 '+boldUnicode('Monthly Due Amount Reminder'),
  '💰 Loan Amount: ₹50,000',
  '📅 Period: 02/07/2026 to 30/07/2026',
  '📆 Due Date: 30-Jul-2026',
  '💳 Due Amount: ₹5,000',
  '',
  '🙏 '+boldUnicode('Kindly arrange the due payment.'),
  '',
  boldUnicode('Money Lenders'),
], 'monthly interest reminder matches the exact requested clean format:\n'+reminder.join('\n'));
assert.ok(!reminder.some(line => line.includes('Loan Type')), 'reminder omits loan type');
assert.ok(!reminder.some(line => line.includes('Current Principal Amount')), 'reminder never shows Current Principal Amount (removed from this format entirely)');
assert.ok(!reminder.some(line => /pending/i.test(line)), 'the old "Your Payment is pending..." wording is completely removed from the interest loan reminder');

// A reduced principal must NOT resurrect a "Current Principal Amount" line —
// this format deliberately has none, regardless of principal paydown.
context.entryLog.push({bid:'IL-MSG', principalComponent:25000, principalPendingAfter:25000});
borrower.remainingPrincipal = 25000;
const reducedReminder = context._interestDueReminderMessage(borrower, {totalDue:5000,cycles}).split('\n');
assert.ok(!reducedReminder.some(line => line.includes('Current Principal Amount')), 'reduced-principal reminder still omits Current Principal Amount');
assert.ok(!reducedReminder.some(line => line.includes('Loan Type')), 'reduced reminder still omits loan type');
borrower.remainingPrincipal = 50000; // restore for the assertions below

const expectedReminderClosing = 'Your Payment is pending. Kindly request you to pay the "Month" Amount.';
assert.equal(context._paymentReminderPendingText(Object.assign({}, borrower, {loanType:'weekly_interest'})), 'Your Payment is pending. Kindly request you to pay the "Week" Amount.', 'weekly reminder selects Week');
assert.equal(context._paymentReminderPendingText(Object.assign({}, borrower, {loanType:'daily_interest'})), 'Your Payment is pending. Kindly request you to pay the "Daily" Amount.', 'daily reminder selects Daily');
assert.equal(context._paymentReminderPendingText(Object.assign({}, borrower, {loanType:'yearly_interest'})), 'Your Payment is pending. Kindly request you to pay the "Year" Amount.', 'yearly reminder selects Year');
assert.equal(context._paymentReminderPendingText(Object.assign({}, borrower, {loanType:'legacy'})), 'Your Payment is pending. Kindly request you to pay the "Due" Amount.', 'unknown legacy reminder falls back to Due');
assert.ok(!extractFunction('sendReminder').includes('Borrower Name:'), 'regular reminder omits borrower-name label');
assert.ok(extractFunction('sendReminder').includes('_paymentReminderPendingText(b)'), 'regular reminder uses period-specific closing text');
assert.ok(extractFunction('_mdcBuildMsg').includes('_paymentReminderPendingText(row.borrower||null)'), 'monthly due reminder uses period-specific closing text');

const principalPayment = {
  id:'P-1', bid:'IL-MSG', name:'ANIL KUMAR', area:'NEHRU NAGAR',
  date:'2026-07-30', pay:'Cash', today:27000, loanType:'monthly_interest', isInterestLoan:true,
  cyclePeriodStart:'2026-07-02', cyclePeriodEnd:'2026-07-30', cycleIndex:2,
  cycleInterest:2000, principalComponent:25000, interestComponent:2000,
  principalPendingAfter:25000, interestPendingAfter:0
};
const paymentLines = context._interestPaymentMessageLines(principalPayment, borrower, 'Transaction Details');
assert.ok(!paymentLines.some(line => /Paid (Month|Week):/.test(line)), 'monthly payment omits paid month/week line');
const rangeIndex = paymentLines.findIndex(line => line.includes('Cycle Period:'));
assert.equal(paymentLines[rangeIndex + 1], icon(0x1F4D1)+' Current Principal Amount: ₹25,000', 'principal amount follows Cycle Period');
assert.ok(!paymentLines.some(line => line.includes('Loan Type')), 'monthly payment omits loan type');
assert.ok(!paymentLines.some(line => line.includes('Current Loan Amount')), 'old current loan label is removed');
assert.ok(paymentLines.some(line => line.includes('Due Paid: ₹2,000')), 'combined payment retains due paid');

const dueOnlyLines = context._interestPaymentMessageLines(Object.assign({}, principalPayment, {
  principalComponent:0, today:2000, principalPendingAfter:25000
}), borrower, 'Transaction Details');
assert.ok(!dueOnlyLines.some(line => line.includes('Current Principal Amount')), 'due-only payment omits current principal');
assert.ok(!dueOnlyLines.some(line => line.includes('Due Paid')), 'due-only payment omits due paid');

const weeklyBorrower = Object.assign({}, borrower, {loanType:'weekly_interest'});
const weeklyReceipt = context._interestPaymentMessageLines(Object.assign({}, principalPayment, {
  loanType:'weekly_interest', effectiveLoanType:'weekly_interest',
  cyclePeriodStart:'2026-07-16', cyclePeriodEnd:'2026-07-23', cycleIndex:4,
  cycleInterest:600, previousPending:600, totalDueAtPayment:1200,
  today:1100, interestComponent:600, principalComponent:500,
  principalPendingAfter:24500, interestPendingAfter:0
}), weeklyBorrower, 'Payment Receipt');
assert.ok(!weeklyReceipt.some(line => /Paid (Month|Week):/.test(line)), 'weekly receipt omits paid month/week line');
// Title is exactly 'Payment Receipt', so this delegates to _interestPaymentReceiptLines
// (see interest-payment-receipt-order.test.js for the full fixed field order):
// Cycle Period is followed by Paid Amount, then Current Principal Amount.
const weeklyRangeIndex = weeklyReceipt.findIndex(line => line.includes('Cycle Period:'));
assert.equal(weeklyReceipt[weeklyRangeIndex + 1], '💵 Paid Amount: ₹1,100', 'Payment Receipt title: Paid Amount immediately follows Cycle Period');
assert.equal(weeklyReceipt[weeklyRangeIndex + 2], '💸 Interest Amount: ₹600', 'Interest Amount immediately follows Paid Amount');
assert.equal(weeklyReceipt[weeklyRangeIndex + 3], icon(0x1F4D1)+' Current Principal Amount: ₹24,500', 'weekly receipt uses saved post-payment principal, now positioned after Interest Amount');
assert.ok(!weeklyReceipt.some(line => line.includes('Loan Type')), 'weekly receipt omits loan type');
assert.ok(!weeklyReceipt.some(line => /Current Due|Total Due|Previous Pending Due/.test(line)), 'Payment Receipt title fully removes Current Due, Total Due and Previous Pending Due');

const closureLines = context._interestClosureMessageLines(Object.assign({}, principalPayment, {
  isLoanClosure:true, closureMode:'full_paid', isFullPaid:true, totalClosureAmount:27000
}), borrower);
assert.ok(!closureLines.some(line => /Paid (Month|Week):/.test(line)), 'success receipt omits paid month/week line');
const closureRangeIndex = closureLines.findIndex(line => line.includes('Cycle Period:'));
assert.equal(closureLines[closureRangeIndex + 1], icon(0x1F4D1)+' Current Principal Amount: ₹25,000', 'success receipt uses saved post-payment principal');
assert.ok(!closureLines.some(line => line.includes('Loan Type')), 'success receipt omits loan type');

const partialCycleMeta = context._interestPaymentMessageMeta(Object.assign({}, principalPayment, {
  cyclePayments:[
    {idx:3,start:'2026-08-02',end:'2026-09-02',amount:500,pendingAfter:1500},
    {idx:2,start:'2026-07-02',end:'2026-08-02',amount:700,pendingAfter:0},
    {idx:3,start:'2026-08-02',end:'2026-09-02',amount:800,pendingAfter:700}
  ]
}), borrower);
assert.equal(partialCycleMeta.paidCycle, 'Month 2–3', 'multiple saved cycles retain their exact month range');
assert.equal(partialCycleMeta.paidCycles.length, 2, 'repeated partial allocations do not duplicate a cycle');
assert.equal(partialCycleMeta.start, '2026-08-02', 'receipt period uses the current/latest saved allocation');
assert.equal(partialCycleMeta.end, '2026-09-02', 'receipt period ends with the current/latest saved allocation');

const verifiedPrevious = context._interestDuePeriodSummary({
  prevPendingArrear: 9000,
  cycles: [
    {idx:1,start:'2026-06-01',end:'2026-07-01',gross:1000,pending:500},
    {idx:2,start:'2026-07-01',end:'2026-08-01',gross:1000,pending:1000},
    {idx:3,start:'2026-08-01',end:'2026-09-01',gross:1000,pending:9999}
  ]
}, '2026-07-01', '2026-08-01', 0, 9999);
assert.deepEqual(
  {current: verifiedPrevious.currentDue, previous: verifiedPrevious.previousDue, total: verifiedPrevious.totalDue},
  {current: 1000, previous: 500, total: 1500},
  'previous due uses only valid earlier completed cycle balances'
);

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'reminder-without-loan-type',
    'reminder-never-shows-current-principal',
    'paid-month-week-lines-removed',
    'partial-payment-cycle-deduplication',
    'due-only-omits-current-principal',
    'success-message-no-loan-type',
    'saved-payment-calculation-preserved',
    'verified-previous-cycle-only'
  ]
}, null, 2));
