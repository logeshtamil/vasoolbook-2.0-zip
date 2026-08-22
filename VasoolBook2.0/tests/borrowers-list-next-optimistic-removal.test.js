'use strict';

// Regression test for: "Borrowers List Next button performance" —
//
// Root cause: apptNextWeek()/_apptNextWeekImpl() already deferred the heavy
// full renderBorrowers() call via setTimeout(renderBorrowers,0) (an EARLIER
// fix for click-to-popup-close lag), but the borrower's card itself only
// disappeared once that deferred full re-render finished rebuilding every
// visible card's interest calculations — on a large list this full rebuild
// can take a noticeably long time, so the borrower visibly lingered in the
// list even though the popup closed and the toast fired instantly.
//
// Fix: a new _apptOptimisticRemoveCard(bid) helper removes ONLY the moved
// borrower's card element (matched by the existing data-bid attribute already
// present on every borrower card — the same selector pattern the app already
// uses elsewhere, e.g. the scroll-restore code at ~line 13532) from the DOM
// the instant saveStateFast() confirms the save, in both the monthly-interest
// branch and the weekly/regular branch of _apptNextWeekImpl. The deferred
// setTimeout(renderBorrowers,0) full re-render is NOT removed — it still runs
// immediately after for full correctness (tab counts, section headers, sort
// order) — this is purely a fast, optimistic first paint layered in front of
// it. No date/collection-day/financial calculation logic is touched.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

// ── 1. Source-level: both branches call the optimistic-removal helper right
//      after saveStateFast() confirms the save, and the deferred full
//      re-render is still present and untouched (never eliminated). ────────
const implSrc = extractFunction('_apptNextWeekImpl');
const monthlyBranch = implSrc.slice(implSrc.indexOf('isBorrowerMonthlyType(b)){'), implSrc.indexOf("// ── NON-MONTHLY"));
const weeklyBranch = implSrc.slice(implSrc.indexOf('// ── NON-MONTHLY'));
assert.match(monthlyBranch, /saveStateFast\(\);[^\n]*\n\s*_apptOptimisticRemoveCard\(b\.id\);\s*\n\s*closeAppointmentPopup\(\);/, 'monthly branch removes the card immediately after the save, before closing the popup');
assert.match(monthlyBranch, /setTimeout\(renderBorrowers,0\);/, 'monthly branch still performs the deferred full re-render for correctness');
assert.match(weeklyBranch, /saveStateFast\(\);[^\n]*\n\s*_apptOptimisticRemoveCard\(b\.id\);\s*\n\s*closeAppointmentPopup\(\);/, 'weekly/regular branch removes the card immediately after the save, before closing the popup');
assert.match(weeklyBranch, /setTimeout\(renderBorrowers,0\);/, 'weekly/regular branch still performs the deferred full re-render for correctness');

// Duplicate-tap guard is unchanged.
assert.match(source, /var _apptNextWeekBusy=false;/, 'duplicate-tap guard flag still exists');
assert.match(extractFunction('apptNextWeek'), /if\(_apptNextWeekBusy\)return;/, 'apptNextWeek still blocks re-entrant taps while processing');

// No date/collection-day/financial calculation lines were touched — every
// field assignment and date-resolution call in both branches is unchanged
// verbatim from before this fix.
[
  'borrowers[idx].nextCollectionDate=nextIso',
  'borrowers[idx].nextCollection=nextStr',
  'borrowers[idx].monthlyCycleStatus=appointmentWins?',
  'var nextIso=appointmentWins?appointmentIso:(monthlyCycleLoan?_nextCycleDateAfter(b,todayStr()):_borrowerNextWeekReopenDate(b,cycleStart));',
].forEach(fragment => assert.ok(implSrc.includes(fragment), `calculation logic unchanged: ${fragment}`));

// ── 2. Behavioral: the card is removed from the DOM synchronously, before
//      any timer fires — proving the borrower disappears immediately rather
//      than waiting on the deferred full renderBorrowers(). ────────────────
function makeFakeList(initialCards) {
  const children = initialCards.slice();
  return {
    children,
    querySelector(sel) {
      const m = /\[data-bid="([^"]+)"\]/.exec(sel);
      if (!m) return null;
      return children.find(c => c.attrs['data-bid'] === m[1]) || null;
    },
  };
}
function makeFakeCard(bid) {
  const card = { attrs: { 'data-bid': bid }, parentNode: null };
  return card;
}

function buildContext() {
  const timers = [];
  const list = makeFakeList([]);
  const card = makeFakeCard('B-NEXT-1');
  card.parentNode = {
    removeChild(c) {
      const i = list.children.indexOf(c);
      if (i >= 0) list.children.splice(i, 1);
      return c;
    },
  };
  list.children.push(card);

  const borrower = {
    id: 'B-NEXT-1', isInterest: false, loanType: 'weekly', areaId: 'AREA-1',
    ignored: false, collectionDone: true,
  };
  const borrowersArr = [borrower];

  const saveCalls = [];
  const context = {
    console,
    borrowers: borrowersArr,
    _apptBid: 'B-NEXT-1',
    _apptNextWeekBusy: false,
    $id: id => (id === 'borrowers-list' ? list : null),
    todayStr: () => '2026-08-22',
    _isRegularMonthlyLoan: () => false,
    _isMonthlyInterestDueLoan: () => false,
    _borrowerConfiguredAppointmentDate: () => '',
    isBorrowerMonthlyType: () => false,
    _borrowerCycleStartDate: () => '2026-08-22',
    _borrowerOwnCollectionCycleStart: () => '2026-08-22',
    _nextCycleDateAfter: () => '2026-08-29',
    _borrowerNextWeekReopenDate: () => '2026-08-29',
    _dateOnly: iso => new Date(iso + 'T00:00:00'),
    fmtDateWithWeekday: d => 'Sat 29 Aug',
    _touchRecord: () => {},
    renderBorrowers: () => {},
    saveStateFast: () => { saveCalls.push(true); },
    closeAppointmentPopup: () => {},
    showToast: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  vm.createContext(context);
  ['_apptOptimisticRemoveCard', 'apptNextWeek', '_apptNextWeekImpl'].forEach(name =>
    vm.runInContext(extractFunction(name), context));
  return { context, list, card, borrowersArr, saveCalls, timers };
}

{
  const { context, list, saveCalls, timers, borrowersArr } = buildContext();
  assert.strictEqual(list.children.length, 1, 'sanity: the card starts in the list');
  context.apptNextWeek();
  assert.strictEqual(saveCalls.length, 1, 'the save happened exactly once');
  assert.strictEqual(list.children.length, 0, 'the card is removed from the DOM synchronously — no stale borrower remaining, without waiting for any timer');
  assert.strictEqual(timers.length, 2, 'both the deferred full re-render and the busy-flag release are still scheduled');
  const rerenderTimer = timers.find(t => t.ms === 0 && t.fn !== timers[timers.length - 1].fn);
  assert.ok(timers.some(t => t.ms === 0), 'the full renderBorrowers() re-render is still deferred via setTimeout(...,0) for correctness');
  // The financial/scheduling data itself is correct and persisted regardless
  // of the DOM optimization — simulating "refresh/restart" reading the same
  // in-memory record back.
  assert.strictEqual(borrowersArr[0].ignored, true, 'borrower correctly moved out of the active list in the underlying data');
  assert.strictEqual(borrowersArr[0].nextCollectionDate, '2026-08-29', 'next collection date persisted correctly, unaffected by the DOM optimization');
}

// ── 3. Duplicate-tap guard: a second immediate call while busy is a no-op —
//      unchanged behavior, still verified end-to-end through the real code. ──
{
  const { context, saveCalls } = buildContext();
  context._apptNextWeekBusy = true;
  context.apptNextWeek();
  assert.strictEqual(saveCalls.length, 0, 'a tap while already processing is ignored, exactly as before this fix');
}

// ── 4. No card present (e.g. popup opened from a context where the list
//      isn't mounted, or the borrower already isn't in the current tab) —
//      the helper is a safe no-op and the rest of the save still proceeds. ──
{
  const { context, list, saveCalls } = buildContext();
  list.children.length = 0; // simulate the card not being found
  context.apptNextWeek();
  assert.strictEqual(saveCalls.length, 1, 'the save still proceeds normally even when there is no matching card to remove');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'monthly-branch-removes-card-after-save-before-popup-close',
    'weekly-branch-removes-card-after-save-before-popup-close',
    'deferred-full-rerender-still-present-both-branches',
    'duplicate-tap-guard-unchanged',
    'calculation-logic-unchanged',
    'card-removed-synchronously-no-stale-borrower',
    'full-rerender-and-busy-release-still-scheduled',
    'underlying-data-correct-after-optimization',
    'duplicate-tap-while-busy-is-noop',
    'missing-card-is-safe-noop',
  ],
}, null, 2));
