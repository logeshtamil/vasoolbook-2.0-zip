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

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const context = {
  Object, Number, Math, isFinite, entryLog: [],
  fmtDate: value => {
    const [y,m,d] = String(value || '').slice(0,10).split('-').map(Number);
    return value ? `${String(d).padStart(2,'0')}-${months[m-1]}-${y}` : '—';
  },
  paymentModeLabel: entry => entry.pay || 'Cash',
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly_interest',
  getInterestBreakdown: () => ({}),
  getInterestCycleCalculation: () => ({
    calculationVersion: 1,
    runningCycleStart: '2026-07-23', runningCycleEnd: '2026-07-30',
    cycles: [
      {idx:4,start:'2026-07-16',end:'2026-07-23',gross:600,pending:600},
      {idx:5,start:'2026-07-23',end:'2026-07-30',gross:600,pending:600}
    ]
  })
};
vm.createContext(context);
[
  '_interestRowsThroughPayment', '_savedPaymentSnapshot', '_messageLoanTypeLabel',
  '_interestMessagePrincipalSnapshot', '_interestDuePeriodSummary', '_interestSavedPaidCycles',
  '_interestPaymentMessageMeta', '_interestPaymentReceiptModel',
  '_interestPaymentReceiptLines', '_interestPaymentReceiptHtml', '_interestPaymentMessageLines'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id:'IL-ORDER', name:'ANIL KUMAR', area:'NEHRU NAGAR',
  loanType:'weekly_interest', isInterest:true, loan:25000, principalAmt:25000,
  remainingPrincipal:24500
};
const entry = {
  id:'PAY-ORDER', bid:'IL-ORDER', name:borrower.name, area:borrower.area,
  date:'2026-07-30', pay:'Cash', today:1100, loanAmt:25000,
  loanType:'weekly_interest', isInterestLoan:true,
  cyclePeriodStart:'2026-07-23', cyclePeriodEnd:'2026-07-30', cycleIndex:5,
  currentCycleStartAtPayment:'2026-07-23', currentCycleEndAtPayment:'2026-07-30',
  currentDueAtPayment:600, previousPendingAtPayment:600, totalDueAtPayment:1200,
  remainingPending:100,
  cycleInterest:600, principalComponent:500, interestComponent:600,
  principalPendingAfter:24500, interestPendingAfter:0
};

// Exact required field order (Current Due / Total Due / Previous Pending Due /
// Pending Due Amount removed completely — due figures live in Info/Reminder/Due
// Center, never on the receipt).
const lines = context._interestPaymentReceiptLines(entry, borrower, 'Payment Receipt', true);
assert.deepEqual(lines, [
  '📋 *Payment Receipt*',
  '👤 *ANIL KUMAR*',
  '📍 NEHRU NAGAR',
  '💰 Loan Amount: ₹25,000',
  '📅 Cycle Period: 23-Jul-2026 → 30-Jul-2026',
  '💵 Paid Amount: ₹1,100',
  '💸 Interest Amount: ₹600',
  '📑 Current Principal Amount: ₹24,500',
  '📅 Payment Date: 30-Jul-2026',
  '💳 Payment Type: Cash',
  '🙏 Thank You.'
]);
assert.equal(lines.filter(line => line.includes('Current Principal Amount')).length, 1);
assert.ok(lines.includes('💸 Interest Amount: ₹600'), 'Interest Amount line is present with the payment interest component');
assert.ok(!lines.some(line => /Current Due|Total Due|Previous Pending Due|Pending Due Amount/.test(line)), 'Current Due, Total Due, Previous Pending Due and Pending Due Amount are all removed');
assert.equal(lines.at(-1), '🙏 Thank You.', 'Thank You is always last');
assert.ok(!lines.some(line => /Principal Paid|Due Paid|Remarks:/.test(line)), 'receipt contains only the canonical payment fields');
// Current Principal Amount must be the correct POST-PAYMENT balance: sourced
// from entry.principalPendingAfter (the value captured at save time), unchanged
// by this reordering — the underlying calculation is untouched.
assert.ok(lines.includes('📑 Current Principal Amount: ₹24,500'), 'Current Principal Amount reflects the post-payment principal balance (principalPendingAfter), not a pre-payment figure');

context.getInterestCycleCalculation = () => ({
  calculationVersion:1, runningCycleStart:'2026-07-23', runningCycleEnd:'2026-07-30',
  cycles:[{idx:5,start:'2026-07-23',end:'2026-07-30',gross:600,pending:600}]
});
const dueOnly = context._interestPaymentReceiptLines(Object.assign({}, entry, {
  principalComponent:0, today:600, principalPendingAfter:24500,
  previousPendingAtPayment:0, totalDueAtPayment:600, remainingPending:0
}), borrower, 'Payment Receipt', true);
assert.ok(!dueOnly.some(line => line.includes('Current Principal Amount')), 'due-only receipt (no principal paid) omits Current Principal Amount, unchanged behavior');
assert.ok(!dueOnly.some(line => /Current Due|Total Due|Previous Pending Due|Pending Due Amount/.test(line)), 'due fields remain fully removed regardless of amounts');
assert.ok(dueOnly.some(line => line.startsWith('💸 Interest Amount:')), 'Interest Amount is shown unconditionally, even on a due-only (no principal paid) receipt');

const html = context._interestPaymentReceiptHtml(entry, borrower, false);
assert.ok(!/Current Due|Total Due|Previous Pending Due|Pending Due Amount/.test(html), 'image/HTML receipt also has Current Due, Total Due, Previous Pending Due and Pending Due Amount fully removed');
assert.ok(/Interest Amount/.test(html), 'image/HTML receipt includes the Interest Amount row');
[
  'Name','Area','Loan Amount','Cycle Period','Paid Amount','Interest Amount','Current Principal Amount','Payment Date','Payment Type','Thank You'
].reduce((last, label) => {
  const next = html.indexOf(label);
  assert.ok(next > last, `${label} follows the required image receipt order`);
  return next;
}, -1);

assert.match(extractFunction('_buildPopupWhatsAppShare'), /_interestPaymentReceiptLines\(_popEntry,b,'Payment Receipt',true\)/);
assert.match(extractFunction('_buildLogMsg'), /_interestPaymentReceiptLines\(e,b,'Payment Receipt',true\)/);
assert.match(extractFunction('_popupReceiptShareText'), /_interestPaymentReceiptLines\(entry,b,'Payment Receipt',true\)/);
assert.match(extractFunction('copyReceiptText'), /_interestPaymentReceiptLines\(_popEntry,b,'Payment Receipt',true\)/);
assert.match(extractFunction('showSavePopup'), /_interestPaymentReceiptHtml\(_popEntry,b,true\)/);
assert.match(extractFunction('updateReceipt'), /_interestPaymentReceiptHtml\(_receiptEntry,b\)/);

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'exact-receipt-order',
    'conditional-current-principal',
    'post-payment-principal-balance',
    'current-due-total-due-previous-pending-removed',
    'no-duplicate-lines',
    'no-post-payment-type-fields',
    'whatsapp-canonical-template',
    'copy-canonical-template',
    'image-canonical-template',
    'payment-success-canonical-template',
    'history-canonical-template'
  ]
}, null, 2));
