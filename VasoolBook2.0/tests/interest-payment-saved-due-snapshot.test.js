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
  Object, Number, Math, isFinite, entryLog: [],
  fmtDate: value => String(value || ''),
  paymentModeLabel: entry => entry.pay || 'Cash',
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly_interest',
  getInterestBreakdown: () => ({}),
  getInterestCycleCalculation: () => ({
    cycleStart: '2099-01-01', cycleEnd: '2099-01-08',
    currentDue: 9999, previousPendingDue: 9999, totalDue: 19998
  })
};
vm.createContext(context);
[
  '_interestRowsThroughPayment', '_savedPaymentSnapshot', '_messageLoanTypeLabel',
  '_interestMessagePrincipalSnapshot', '_interestDuePeriodSummary', '_interestSavedPaidCycles',
  '_interestPaymentMessageMeta', '_interestPaymentReceiptModel', '_interestPaymentReceiptLines'
].forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {
  id: 'IL-SNAPSHOT', name: 'SAVED CYCLE', area: 'OWN AREA',
  loanType: 'monthly_interest', isInterest: true, loan: 50000, principalAmt: 50000,
  remainingPrincipal: 50000
};
const entry = Object.freeze({
  id: 'PAY-SNAPSHOT', bid: borrower.id, date: '2026-07-30', pay: 'UPI', today: 600,
  loanAmt: 50000, loanType: 'monthly_interest', isInterestLoan: true,
  currentCycleStartAtPayment: '2026-07-01', currentCycleEndAtPayment: '2026-07-31',
  currentDueAtPayment: 1200, previousPendingAtPayment: 800, totalDueAtPayment: 2000,
  remainingPending: 1400, interestComponent: 600
});

const model = context._interestPaymentReceiptModel(entry, borrower, 'Payment Receipt');
assert.deepEqual(
  { start: model.cycleStart, end: model.cycleEnd, current: model.currentDue, previous: model.previousDue, total: model.totalDue, pending: model.pendingDue },
  { start: '2026-07-01', end: '2026-07-31', current: 1200, previous: 800, total: 2000, pending: 1400 },
  'saved due snapshot wins over the later live cycle calculation'
);

// The receipt text no longer renders Current Due / Previous Pending Due / Total
// Due / Pending Due Amount at all (removed completely) — but the underlying
// model above still carries the correct saved-snapshot values (proven by the
// assert.deepEqual on `model` above), so nothing about the due-snapshot
// calculation itself changed, only what the receipt chooses to display.
const lines = context._interestPaymentReceiptLines(entry, borrower, 'Payment Receipt', true);
assert.deepEqual(lines.slice(-5), [
  '💵 Paid Amount: ₹600',
  '💸 Interest Amount: ₹600',
  '📅 Payment Date: 2026-07-30',
  '💳 Payment Type: UPI',
  '🙏 Thank You.'
], 'receipt tail (no principal paid on this entry, so Current Principal Amount is correctly omitted): Paid Amount, Interest Amount, Payment Date, Payment Type, Thank You');
assert.equal(lines.at(-1), '🙏 Thank You.', 'receipt closes with Thank You');
assert.ok(!lines.join('\n').includes('2099-01'), 'receipt never uses a later live cycle for a saved payment');
assert.ok(!lines.some(line => /Current Due|Previous Pending Due|Total Due|Pending Due Amount/.test(line)), 'Current Due, Previous Pending Due, Total Due and Pending Due Amount are all removed regardless of the saved snapshot values');

const noPrevious = context._interestPaymentReceiptLines(Object.assign({}, entry, {
  currentDueAtPayment: 1200, previousPendingAtPayment: 0, totalDueAtPayment: 1200,
  today: 1200, remainingPending: 0
}), borrower, 'Payment Receipt', true);
assert.ok(!noPrevious.some(line => /Current Due|Previous Pending Due|Total Due|Pending Due Amount/.test(line)), 'due fields stay fully removed with a zero previous/pending due too');

assert.match(source, /currentCycleStartAtPayment:\(b\.isInterest\?_currentCycleStartAtPayment:''\)/);
assert.match(source, /currentDueAtPayment:\(b\.isInterest\?_currentDueAtPayment:0\)/);
assert.match(source, /previousPendingAtPayment:\(b\.isInterest\?_previousPendingAtPayment:0\)/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'saved-current-cycle-period',
    'saved-current-previous-total-due',
    'pending-equals-saved-total-less-payment',
    'no-stale-live-cycle',
    'zero-conditional-lines',
    'payment-save-snapshot-fields'
  ]
}, null, 2));
