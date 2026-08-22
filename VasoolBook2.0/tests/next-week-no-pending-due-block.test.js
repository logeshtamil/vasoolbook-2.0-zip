'use strict';

// Regression test: Next Week/Next Month must never be blocked ("rejected")
// by a pending due amount for Monthly Interest loans. Root cause: a guard
// in _apptNextWeekImpl's monthly-interest branch checked
// _monthlyInterestWorkflowState(...).payableDue > 0.01 and, if true, showed
// a warning toast and returned WITHOUT scheduling — refusing the follow-up
// action entirely. Next Week is a pure scheduling action, not a collection
// gate, and must behave the same for every loan type: the pending amount
// itself is never touched (not deleted/forgiven) by this fix — only the
// refusal-to-schedule behavior is removed.

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

// ── 1. Source-level: the blocking guard is gone.
const implSource = extractFunction('_apptNextWeekImpl');
assert.ok(!/payableDue>0\.01/.test(implSource), 'the payableDue>0.01 blocking check no longer exists');
assert.ok(!/still due for this loan/.test(implSource), 'the "still due, collect or record it first" refusal message is gone');
assert.ok(!/_monthlyInterestWorkflowState/.test(implSource), '_apptNextWeekImpl no longer even computes the workflow state it used to gate on');

// ── 2. Behavioral: a monthly interest loan WITH a large pending due still
//      schedules successfully (financial fields untouched, action permitted).
{
  const b = { id: 'b1', name: 'Pending Interest Borrower', isInterest: true, loanType: 'monthly_interest', remainingPrincipal: 50000, lastInterestPending: 4000 };
  const context = {
    Object, String, Boolean, Number, Math,
    _apptBid: 'b1',
    borrowers: [b],
    todayStr: () => '2026-08-20',
    _isRegularMonthlyLoan: () => false,
    _isMonthlyInterestDueLoan: () => true,
    _borrowerConfiguredAppointmentDate: () => '',
    _borrowerCycleStartDate: () => '2026-08-01',
    _borrowerOwnCollectionCycleStart: () => '2026-08-01',
    _nextCycleDateAfter: () => '2026-09-01',
    _borrowerNextWeekReopenDate: () => '2026-08-27',
    _dateOnly: value => value,
    fmtDateWithWeekday: () => 'Tue, 01 Sep 2026',
    isBorrowerMonthlyType: () => true,
    _touchRecord: row => { row.touched = true; },
    saveStateFast: () => { context.saved = (context.saved || 0) + 1; },
    renderBorrowers: () => { context.rendered = (context.rendered || 0) + 1; },
    closeAppointmentPopup: () => { context.closed = (context.closed || 0) + 1; },
    showToast: msg => { context.toastMessages = (context.toastMessages || []).concat(msg); },
    setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('_apptOptimisticRemoveCard'), context);
  vm.runInContext(extractFunction('_apptNextWeekImpl'), context);

  context._apptNextWeekImpl(b, 0);

  assert.ok(!(context.toastMessages || []).some(m => /still due|collect or record/i.test(m)), 'no "still due" refusal toast is shown, regardless of pending interest');
  assert.strictEqual(context.borrowers[0].ignored, true, 'the borrower is still scheduled (moved to Closed/waiting) despite the pending due');
  assert.strictEqual(context.borrowers[0].nextCollectionDate, '2026-09-01', 'the next collection date is still set from the existing, unchanged date logic');
  assert.strictEqual(context.borrowers[0].lastInterestPending, 4000, 'the pending interest amount itself is completely untouched — never deleted or forgiven');
  assert.strictEqual(context.saved, 1, 'the action still saves normally');
  assert.strictEqual(context.closed, 1, 'the popup still closes normally');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'blocking-guard-removed-from-source',
    'refusal-message-removed',
    'workflow-state-lookup-removed',
    'monthly-interest-with-pending-due-still-schedules',
    'no-refusal-toast-shown',
    'pending-amount-untouched',
    'save-and-close-still-happen',
  ],
}, null, 2));
