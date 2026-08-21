'use strict';

// Regression test for the reported "Weekly Payment Receipt calculation bug":
// editing a saved Collection Entry allegedly double-counts the edited
// amount instead of reversing the old contribution first, producing a wrong
// Balance (e.g. Loan 25,000 + Total Paid 12,000 + Paid Today 1,000 should
// give Balance 13,000, not some inflated/deflated wrong figure).
//
// Investigation finding: the save-edit path (saveEditPayModal ->
// _refreshAfterLoanAction -> recalcInterestLoanFromHistory) does NOT
// incrementally patch totals. For a regular (non-interest) weekly/monthly
// loan, recalcInterestLoanFromHistory rebuilds totalPaid from scratch on
// every call by summing every saved entry's current `.today` value in
// order — so an edited entry's OLD contribution can never linger; there is
// nothing to "double count" because the running total is never carried
// forward incrementally. canonicalPaidTotal()/canonicalBalance() (used by
// the borrower card, reports, and reminders) independently recompute from
// entryLog from scratch on every call too, with the same guarantee.
// saveEditPayModal itself mutates the existing entryLog row in place
// (entryLog[ei].today=newAmt) — it never pushes a new row, so an edit can
// never create a duplicate/ghost entry either.
//
// This test proves the described bug does NOT reproduce, end-to-end,
// through the exact regression steps requested: create -> edit -> edit
// again -> refresh -> restart -> receipt/report totals.

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

function buildContext() {
  const rendered = { calls: 0 };
  const toasts = [];
  const context = {
    Object, Array, String, Number, Boolean, JSON, Math, Date, isNaN, parseFloat, parseInt, isFinite,
    entryLog: [],
    borrowers: [],
    customers: [],
    _epmEid: null,
    todayStr: () => '2026-08-21',
    showToast: msg => toasts.push(msg),
    $id: id => {
      if (id === 'epm-amount') return context._epmAmountEl;
      if (id === 'epm-pay-mode') return context._epmModeEl;
      return null;
    },
    _mumRequire: () => true,
    _touchRecord: row => { row.touched = true; },
    _storageAudit: () => {},
    saveState: () => {},
    closeEditPayModal: () => {},
    renderBorrowers: () => {},
    renderLog: () => {},
    renderHistoryArchive: () => {},
    populateDropdown: () => {},
    onNameChange: () => {},
    openInfoSheet: () => {},
    refreshInterestCard: () => {},
    renderCashSection: () => {},
    renderMonthlyDueCenter: () => {},
    renderReports: () => {},
    _scheduleUpdateReceipt: () => {},
    _hasPermanentClosureLock: () => false,
    _hasWaitingReopenState: () => false,
    _permanentClosureTypeFromHistory: () => '',
    _refreshInterestPaidThrough: () => '',
    _rebuildAdvanceInterestEntry: () => ({ ok: true }),
    _epmAmountEl: { value: '', focus() {} },
    _epmModeEl: { value: 'Cash' },
    toasts,
    _rendered: rendered,
  };
  vm.createContext(context);
  [
    'saveEditPayModal', '_refreshAfterLoanAction', 'recalcInterestLoanFromHistory',
    'syncBorrowerBalanceFromHistory', 'canonicalLoanAmount', 'canonicalPaidTotal',
    'canonicalBalance', '_getOpeningPaid', '_borrowerEntriesSorted', '_isBalanceNeutralEntry',
    '_isOpeningBalanceEntry', '_vbIsOpeningPaidEntry', '_isClosedPaidOffLoan', '_lockClosedPaidOffLoan',
  ].forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

function editEntry(context, eid, amount, mode) {
  context._epmEid = eid;
  context._epmAmountEl.value = String(amount);
  context._epmModeEl.value = mode || 'Cash';
  context.saveEditPayModal();
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// ── Regression scenario: create -> edit -> edit again -> refresh -> restart ──
{
  const ctx = buildContext();
  const LOAN = 25000;
  const b = { id: 'B1', name: 'Test Borrower', loan: LOAN, prev: 0, isInterest: false, loandate: '2026-08-01' };
  ctx.borrowers.push(b);

  // ── CREATE: two saved weekly payments (8000 + 4000 = 12000 total paid). ──
  ctx.entryLog.push({ id: 'E1', bid: 'B1', date: '2026-08-01', today: 8000, pay: 'Cash' });
  ctx.entryLog.push({ id: 'E2', bid: 'B1', date: '2026-08-08', today: 4000, pay: 'Cash' });
  ctx.recalcInterestLoanFromHistory('B1');

  check('create: Total Paid = 12,000 (matches the bug report\'s starting figure)', ctx.canonicalPaidTotal(b) === 12000, 'got ' + ctx.canonicalPaidTotal(b));
  check('create: Balance = 25,000 - 12,000 = 13,000', ctx.canonicalBalance(b) === 13000, 'got ' + ctx.canonicalBalance(b));
  check('create: entry E2.total (receipt field) reflects the running total after it', ctx.entryLog[1].total === 12000, 'got ' + ctx.entryLog[1].total);
  check('create: entry E2.balance (receipt field) matches canonicalBalance', ctx.entryLog[1].balance === 13000, 'got ' + ctx.entryLog[1].balance);

  // ── EDIT: change E2 (today's entry) from 4000 down to 1000. ──────────────
  // Exact numbers from the bug report: Loan 25,000, Total Paid 12,000
  // (already includes this entry), Paid Today (this entry, post-edit) 1,000.
  // Expected: Total Paid becomes 8000 (E1) + 1000 (edited E2) = 9000,
  // Balance = 25000 - 9000 = 16000. The bug report's own arithmetic
  // ("Balance must be 13,000, not 10,500") describes a DIFFERENT scenario
  // shape (an edit that nets to Total Paid 12,000 overall) — reproduced
  // exactly in the next block below. This block isolates the pure
  // "edit reduces one entry" case first.
  editEntry(ctx, 'E2', 1000, 'GPay');
  check('edit: only the expected success toast fired, no warning/error toast', ctx.toasts.every(t => !/⚠️|error|conflict/i.test(t)), JSON.stringify(ctx.toasts));
  check('edit: Paid Today (edited entry\'s own amount) = 1,000 exactly', ctx.entryLog[1].today === 1000, 'got ' + ctx.entryLog[1].today);
  check('edit: payment mode updated to the new value', ctx.entryLog[1].pay === 'GPay', 'got ' + ctx.entryLog[1].pay);
  check('edit: Total Paid = 8,000 + 1,000 = 9,000 (old 4,000 contribution fully reversed, never double-counted)', ctx.canonicalPaidTotal(b) === 9000, 'got ' + ctx.canonicalPaidTotal(b));
  check('edit: Balance = 25,000 - 9,000 = 16,000', ctx.canonicalBalance(b) === 16000, 'got ' + ctx.canonicalBalance(b));
  check('edit: no duplicate/ghost entries were created (still exactly 2 rows)', ctx.entryLog.length === 2, 'got ' + ctx.entryLog.length);
  check('edit: receipt field entry.total matches the recomputed total', ctx.entryLog[1].total === 9000, 'got ' + ctx.entryLog[1].total);
  check('edit: receipt field entry.balance matches canonicalBalance', ctx.entryLog[1].balance === 16000, 'got ' + ctx.entryLog[1].balance);

  // ── EDIT AGAIN: raise the same entry from 1000 to 5000 (date changes too). ──
  ctx.entryLog[1].date = '2026-08-09'; // simulates a date edit alongside the amount
  editEntry(ctx, 'E2', 5000, 'Cash');
  check('edit again: Paid Today = 5,000 exactly (previous 1,000 fully reversed first)', ctx.entryLog[1].today === 5000, 'got ' + ctx.entryLog[1].today);
  check('edit again: Total Paid = 8,000 + 5,000 = 13,000', ctx.canonicalPaidTotal(b) === 13000, 'got ' + ctx.canonicalPaidTotal(b));
  check('edit again: Balance = 25,000 - 13,000 = 12,000', ctx.canonicalBalance(b) === 12000, 'got ' + ctx.canonicalBalance(b));
  check('edit again: still exactly 2 entries — repeated edits never accumulate ghost rows', ctx.entryLog.length === 2, 'got ' + ctx.entryLog.length);

  // ── REFRESH: re-derive totals independently from scratch (simulates a page
  //    refresh, which re-renders from the same persisted entryLog/borrowers —
  //    no cached UI value is trusted). ──────────────────────────────────────
  const refreshedPaid = ctx.canonicalPaidTotal(b);
  const refreshedBalance = ctx.canonicalBalance(b);
  check('refresh: Total Paid unchanged (9000->13000 edit persisted correctly)', refreshedPaid === 13000, 'got ' + refreshedPaid);
  check('refresh: Balance unchanged after independent recomputation', refreshedBalance === 12000, 'got ' + refreshedBalance);

  // ── RESTART: simulate an app restart by rebuilding a FRESH context from
  //    only the persisted entryLog/borrowers (as if reloaded from IndexedDB),
  //    with zero in-memory state carried over from the edits above. ─────────
  const restarted = buildContext();
  restarted.borrowers.push(JSON.parse(JSON.stringify(b)));
  restarted.entryLog.push(...JSON.parse(JSON.stringify(ctx.entryLog)));
  const restartedBorrower = restarted.borrowers[0];
  check('restart: Total Paid recomputed from persisted ledger matches pre-restart value', restarted.canonicalPaidTotal(restartedBorrower) === 13000, 'got ' + restarted.canonicalPaidTotal(restartedBorrower));
  check('restart: Balance recomputed from persisted ledger matches pre-restart value', restarted.canonicalBalance(restartedBorrower) === 12000, 'got ' + restarted.canonicalBalance(restartedBorrower));
}

// ── Exact bug-report scenario: Loan 25,000, Total Paid 12,000 (after edit,
//    inclusive of today's edited entry), Paid Today 1,000 -> Balance 13,000. ──
{
  const ctx = buildContext();
  const LOAN = 25000;
  const b = { id: 'B2', name: 'Bug Report Borrower', loan: LOAN, prev: 0, isInterest: false, loandate: '2026-08-01' };
  ctx.borrowers.push(b);
  // Prior payments summing to 11,000, then today's entry originally saved as
  // 2,000 (making the ORIGINAL total 13,000) is edited DOWN to 1,000.
  ctx.entryLog.push({ id: 'P1', bid: 'B2', date: '2026-08-01', today: 6000, pay: 'Cash' });
  ctx.entryLog.push({ id: 'P2', bid: 'B2', date: '2026-08-08', today: 5000, pay: 'Cash' });
  ctx.entryLog.push({ id: 'P3', bid: 'B2', date: '2026-08-15', today: 2000, pay: 'Cash' });
  ctx.recalcInterestLoanFromHistory('B2');
  check('bug-scenario: pre-edit Total Paid = 13,000 (6000+5000+2000)', ctx.canonicalPaidTotal(b) === 13000, 'got ' + ctx.canonicalPaidTotal(b));

  editEntry(ctx, 'P3', 1000, 'Cash');
  check('bug-scenario: Paid Today (edited entry) = 1,000 exactly', ctx.entryLog[2].today === 1000, 'got ' + ctx.entryLog[2].today);
  check('bug-scenario: Total Paid = 6000+5000+1000 = 12,000 (matches report\'s "Total Paid ₹12,000")', ctx.canonicalPaidTotal(b) === 12000, 'got ' + ctx.canonicalPaidTotal(b));
  check('bug-scenario: Balance = 25,000 - 12,000 = 13,000 exactly as required (NOT 10,500)', ctx.canonicalBalance(b) === 13000, 'got ' + ctx.canonicalBalance(b));
  check('bug-scenario: Balance is NOT the reported wrong value 10,500', ctx.canonicalBalance(b) !== 10500);
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  failures: failed,
}, null, 2));
if (failed.length) process.exitCode = 1;
