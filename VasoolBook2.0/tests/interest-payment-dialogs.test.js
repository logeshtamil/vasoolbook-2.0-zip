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

const context = { Object, Math, parseFloat };
vm.createContext(context);
vm.runInContext(extractFunction('interestPaymentDecision'), context);

const under = context.interestPaymentDecision(3000, 2000, 0);
assert.equal(under.state, 'underpayment');
assert.equal(under.pending, 1000);
assert.equal(under.excess, 0);

const discounted = context.interestPaymentDecision(3000, 2000, 1000);
assert.equal(discounted.state, 'covered');
assert.equal(discounted.payable, 2000);
assert.equal(discounted.pending, 0);

const over = context.interestPaymentDecision(3000, 3500, 0);
assert.equal(over.state, 'overpayment');
assert.equal(over.excess, 500);
assert.equal(over.interestPaidNow, 3000);

const rounded = context.interestPaymentDecision(100.005, 90.004, 0);
assert.equal(rounded.interestDue, 100.01);
assert.equal(rounded.paidAmount, 90);
assert.equal(rounded.pending, 10.01);

const underDialog = extractFunction('showInterestBalancePopup');
['Interest Balance Detected', 'Interest Pending', 'Discount', 'Cancel'].forEach(label => {
  assert.ok(underDialog.includes(label), `underpayment dialog contains ${label}`);
});
assert.ok(underDialog.includes('var decided=false'), 'underpayment choice is one-shot');
assert.ok(underDialog.includes("finish('cancel')"), 'underpayment cancel is read-only');
assert.ok(underDialog.includes("'interest_only',0,'pending'"), 'pending decision is persisted');
assert.ok(underDialog.includes("'interest_only',pending,'discount'"), 'discount decision is persisted');

const excessDialog = extractFunction('showExcessInterestPaymentPopup');
['Credit to Next Cycle', 'Accept Extra Payment', 'Cancel'].forEach(label => {
  assert.ok(excessDialog.includes(label), `overpayment dialog contains ${label}`);
});
assert.ok(excessDialog.includes('cloneNode(true)'), 'stale popup listeners are replaced');
assert.ok(excessDialog.includes("button.style.display='flex'"), 'hidden action state is reset');
assert.ok(excessDialog.includes('var decided=false'), 'overpayment choice is one-shot');

const saveEntry = extractFunction('saveEntry');
assert.ok(saveEntry.includes('showExcessInterestPaymentPopup({'), 'interest overpayment uses restored dialog');
assert.ok(saveEntry.includes("'interest_only',_discV,'accept_extra'"), 'accept choice has stable metadata');

const saveStart = source.indexOf('function _proceedSaveEntry(');
// _advanceInterestSelectedPeriods used to mark the end of this section — it
// was dead code (zero callers) reading the now-removed #ci-advance-periods
// UI input, and was removed by the Interest Loan payment UI update.
// _proceedSaveEntryNextCycle immediately follows in its place.
const saveEnd = source.indexOf('function _proceedSaveEntryNextCycle(', saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, 'payment save section exists');
const save = source.slice(saveStart, saveEnd);
assert.ok(save.includes("interestBalanceChoice==='accept_extra'"), 'accepted extra is handled explicitly');
assert.ok(save.includes('_allocationInterestAmount'), 'accepted extra is excluded from future-cycle allocation');
assert.ok(save.includes('acceptedExtraInterest:'), 'accepted extra is retained on the saved transaction');
assert.ok(save.includes('var isFullyDone = _settlementAfter.settled'), 'interest payment cannot auto-close principal balance');

const creditStart = source.indexOf('function _proceedSaveEntryNextCycle(');
const creditEnd = source.indexOf('function ', creditStart + 20);
assert.ok(creditStart >= 0 && creditEnd > creditStart, 'next-cycle save section exists');
const credit = source.slice(creditStart, creditEnd);
assert.ok(credit.includes('principalComponent:principalComp,interestComponent:today'), 'full credited payment is reported once');
assert.ok(credit.includes("interestBalanceChoice:'credit_next_cycle'"), 'credit choice is retained');
assert.ok(credit.includes('cyclePayments:(currentAlloc.payments||[]).concat(advancePlan.payments||[])'), 'credit uses explicit cycle allocations');
assert.ok(!credit.includes('interestCredit=(parseFloat(cur.interestCredit)||0)+excess'), 'flat credit is not double-counted');

const allocation = extractFunction('_allocateInterestToCompletedCycles');
assert.ok(allocation.includes('if(!usedExplicit)freeTotal+=amt'), 'explicit allocations are not reapplied as free interest');
assert.ok(source.includes("acceptedExtraInterest:num('acceptedExtraInterest',0)"), 'receipt/message snapshot retains accepted extra');
assert.ok(source.includes('Accepted Extra Payment</span>'), 'history displays accepted extra');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'underpayment-decision',
    'discount-clears-exact-balance',
    'overpayment-decision',
    'paise-rounding',
    'underpayment-dialog-options',
    'overpayment-dialog-options',
    'cancel-read-only',
    'one-shot-actions',
    'stale-listener-reset',
    'accepted-extra-current-cycle-only',
    'next-cycle-explicit-allocation',
    'no-double-counting',
    'settlement-only-closure',
    'saved-record-display-consistency'
  ]
}, null, 2));
