'use strict';

// Regression test for the "Next Week button workflow lag" bug.
//
// Root cause: apptNextWeek() called the full-list renderBorrowers() (rebuilds
// every visible card + recomputes every interest-loan cycle calculation)
// BEFORE closeAppointmentPopup()/showToast() — so the popup visually just sat
// there, unresponsive, until that heavy render finished. saveStateFast() was
// already a targeted/deferred fast-save path and was never the bottleneck.
//
// Fix: only the DISPLAY order/timing changed. The popup now closes and the
// confirmation toast fires synchronously and immediately — the actual "the
// button responds" moment — and the unchanged renderBorrowers() call is
// deferred one tick via setTimeout(...,0) so it can never block that
// feedback. No date/reopen/calculation logic was touched. A busy guard
// (released in `finally`) blocks a duplicate tap from re-entering.

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

function freshContext(borrower) {
  const events = [];
  const RENDER_COST_MS = 40; // simulates the real full-list render's cost
  const context = {
    Object, String, Boolean, Number, Math,
    setTimeout, clearTimeout,
    _apptBid: borrower.id,
    borrowers: [borrower],
    todayStr: () => '2026-08-20',
    fmtDateWithWeekday: () => 'Thu, 27 Aug 2026',
    fmt: n => String(n),
    _isRegularMonthlyLoan: () => false,
    _isMonthlyInterestDueLoan: () => false,
    _borrowerConfiguredAppointmentDate: () => '',
    _borrowerCycleStartDate: () => '2026-08-13',
    _borrowerOwnCollectionCycleStart: () => '2026-08-13',
    _borrowerNextWeekReopenDate: () => '2026-08-27',
    _dateOnly: iso => iso,
    _touchRecord: () => {},
    isBorrowerMonthlyType: () => false,
    _monthlyInterestWorkflowState: () => ({ payableDue: 0 }),
    saveStateFast() { events.push({ t: 'save', at: Date.now() }); },
    closeAppointmentPopup() { events.push({ t: 'close', at: Date.now() }); },
    showToast(msg) { events.push({ t: 'toast', at: Date.now(), msg }); },
    renderBorrowers() {
      // Busy-wait to simulate the real function's synchronous cost — this is
      // what used to block the popup close/toast before the fix.
      const until = Date.now() + RENDER_COST_MS;
      while (Date.now() < until) { /* simulate heavy synchronous work */ }
      events.push({ t: 'render', at: Date.now() });
    },
    _apptNextWeekBusy: false,
    _events: events,
    RENDER_COST_MS,
  };
  vm.createContext(context);
  ['apptNextWeek', '_apptNextWeekImpl'].forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── 1. The heavy render must never run before close+toast — it must be
  //      deferred to AFTER them, not interleaved or reordered back.
  {
    const ctx = freshContext({ id: 'b1', name: 'Weekly Borrower', isInterest: true, loanType: 'weekly_interest' });
    const start = Date.now();
    ctx.apptNextWeek();
    const closeEvent = ctx._events.find(e => e.t === 'close');
    const toastEvent = ctx._events.find(e => e.t === 'toast');
    const renderEventAtCallTime = ctx._events.find(e => e.t === 'render');
    check('popup closes synchronously, before any render happens', !!closeEvent && !renderEventAtCallTime);
    check('toast fires synchronously, before any render happens', !!toastEvent && !renderEventAtCallTime);
    check('close+toast happen almost instantly (well under the simulated render cost)', (closeEvent.at - start) < ctx.RENDER_COST_MS, 'elapsed=' + (closeEvent.at - start) + 'ms, renderCost=' + ctx.RENDER_COST_MS + 'ms');
    await wait(ctx.RENDER_COST_MS + 30);
    const renderEvent = ctx._events.find(e => e.t === 'render');
    check('the render eventually still runs (unchanged refresh, just deferred)', !!renderEvent);
    check('the render ran strictly after close and toast (order preserved, only timing deferred)', renderEvent.at >= closeEvent.at && renderEvent.at >= toastEvent.at);
  }

  // ── 2. Same ordering holds for the Monthly Interest ("Next Month") branch.
  {
    const ctx = freshContext({ id: 'b2', name: 'Monthly Borrower', isInterest: true, loanType: 'monthly_interest' });
    ctx.isBorrowerMonthlyType = () => true;
    ctx._nextCycleDateAfter = () => '2026-09-13';
    ctx.apptNextWeek();
    const closeEvent = ctx._events.find(e => e.t === 'close');
    const renderEventAtCallTime = ctx._events.find(e => e.t === 'render');
    check('monthly branch: popup closes before any render (same fix applies to both branches)', !!closeEvent && !renderEventAtCallTime);
    await wait(ctx.RENDER_COST_MS + 30);
    check('monthly branch: the deferred render still eventually runs', !!ctx._events.find(e => e.t === 'render'));
  }

  // ── 3. Duplicate-tap guard: a second call while the first is still
  //      in-flight (deferred render pending) must be ignored, not start a
  //      second overlapping save/render cycle.
  {
    const ctx = freshContext({ id: 'b3', name: 'Double Tap Borrower', isInterest: true, loanType: 'weekly_interest' });
    ctx.apptNextWeek(); // first tap
    ctx.apptNextWeek(); // immediate second tap, must be a no-op
    const saveCount = ctx._events.filter(e => e.t === 'save').length;
    check('an immediate duplicate tap does not trigger a second save', saveCount === 1, 'saveCount=' + saveCount);
    await wait(ctx.RENDER_COST_MS + 30);
    const renderCount = ctx._events.filter(e => e.t === 'render').length;
    check('an immediate duplicate tap does not trigger a second render', renderCount === 1, 'renderCount=' + renderCount);
  }

  // ── 4. The busy guard is always released (via `finally`), so a later,
  //      separate tap (after the first fully resolves) works normally again.
  {
    const ctx = freshContext({ id: 'b4', name: 'Later Tap Borrower', isInterest: true, loanType: 'weekly_interest' });
    ctx.apptNextWeek();
    await wait(ctx.RENDER_COST_MS + 30);
    ctx.apptNextWeek(); // a genuinely separate, later tap
    const saveCount = ctx._events.filter(e => e.t === 'save').length;
    check('the busy guard releases after completion, so a later separate tap still works', saveCount === 2, 'saveCount=' + saveCount);
  }

  // ── 5. Data/calculation fields untouched: same set of borrower field
  //      writes as before the fix (only display order/timing changed).
  {
    const b = { id: 'b5', name: 'Field Check Borrower', isInterest: true, loanType: 'weekly_interest' };
    const ctx = freshContext(b);
    ctx.apptNextWeek();
    const updated = ctx.borrowers[0];
    check('ignored flag set (moves to Closed/Skipped tab, unchanged logic)', updated.ignored === true);
    check('collectionDone reset (unchanged logic)', updated.collectionDone === false);
    check('nextCollectionDate set from the unchanged reopen-date calculation', updated.nextCollectionDate === '2026-08-27');
    check('monthlyCycleStatus set to next_week for a non-monthly loan (unchanged logic)', updated.monthlyCycleStatus === 'next_week');
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
    failures: failed,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
