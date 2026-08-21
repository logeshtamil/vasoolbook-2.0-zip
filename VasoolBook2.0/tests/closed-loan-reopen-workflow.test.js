'use strict';

// Verifies the restored Closed Account "Reopen" workflow: a typed reason is required,
// an Admin PIN is verified before any mutation happens, the reopen is fully audited
// (Reopened By + Date/Time + Reason + authorizing Admin), the loan's existing
// balance/history is restored in place (no transactions recreated or deleted), a
// mistaken paid-off/permanent closure still cannot be reopened, and both entry points
// (Info-sheet popup and Loan History page) enforce the same contract consistently.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

function buildContext(overrides) {
  const context = Object.assign({
    JSON, Object, Array, String, Number, Math, Date, console,
    borrowers: [], entryLog: [],
    _reopenConfirmBusy: false, _lhReopenBusy: false,
    _mumRequire: () => true,
    _isClosedPaidOffLoan: () => false,
    _lockClosedPaidOffLoan: () => false,
    _touchRecord(row) { row.touched = true; },
    _syncUserName: () => 'Field Agent',
    cfg: () => '',
    todayStr: () => '2026-08-19',
    fmt: v => String(v),
    uid: (() => { let n = 0; return () => 'entry-' + (++n); })(),
    prompts: [],
    prompt(msg) { return context.prompts.length ? context.prompts.shift() : null; },
    showToast(msg) { context.toasts = context.toasts || []; context.toasts.push(msg); },
    _appLockAdminOk: async (userId, pin) => userId === 'U001' && pin === '1234',
    _refreshAfterLoanActionCalls: 0,
    _refreshAfterLoanAction() { context._refreshAfterLoanActionCalls += 1; },
    renderLoanHistoryPage() {},
    openInfoSheet() {},
    closeReopenPopup() {},
    saveState() {},
    renderBorrowers() {}
  }, overrides || {});
  vm.createContext(context);
  return context;
}

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── source-level contract checks ─────────────────────────────────────────
  const confirmReopenSrc = functionSource('confirmReopenLoan');
  const lhReopenSrc = functionSource('lhReopenLoan');
  [['Info-sheet reopen', confirmReopenSrc], ['Loan History reopen', lhReopenSrc]].forEach(([label, src]) => {
    check(label + ': requires a non-empty reason before any PIN prompt', /reason/.test(src) && src.indexOf('_appLockAdminOk') > src.indexOf(label.includes('Info') ? 'reasonEl' : 'reason='));
    check(label + ': verifies Admin PIN via _appLockAdminOk before mutating the loan', src.includes('_appLockAdminOk('));
    check(label + ': records reopenedBy/reopenedAt/reopenAuthorizedBy/reopenReason in the audit entry', /reopenedBy:/.test(src) && /reopenedAt:/.test(src) && /reopenAuthorizedBy:/.test(src) && /reopenReason:/.test(src));
    check(label + ': still blocks a mistaken paid-off/permanent closure from being reopened', src.includes('_isClosedPaidOffLoan'));
    check(label + ': guards against duplicate/concurrent reopen taps', /_reopenConfirmBusy|_lhReopenBusy/.test(src));
    check(label + ': PIN verification happens before any borrowers[] mutation (cancel/fail leaves data untouched)', src.indexOf('_appLockAdminOk(') < src.search(/borrowers\[i(dx)?\]\.completed=false/));
  });

  // ── behavioral checks: confirmReopenLoan ────────────────────────────────
  {
    const ctx = buildContext({
      document: { getElementById: id => (id === 'reopen-reason-inp' ? { value: 'Customer paid remaining balance directly' } : null) },
      $id: id => ctx.document.getElementById(id)
    });
    ctx.borrowers = [{ id: 'loan-1', name: 'Alice', loan: 10000, prev: 10000, closed: true, completed: true, isInterest: false }];
    vm.runInContext(functionSource('confirmReopenLoan'), ctx);
    // No prompts queued -> first prompt() call (Admin User ID) returns null -> cancelled
    ctx.prompts = [];
    await ctx.confirmReopenLoan('loan-1');
    check('cancelling the Admin User ID prompt leaves the loan closed (no mutation)', ctx.borrowers[0].closed === true);
    check('cancelling never adds an audit entry', ctx.entryLog.length === 0);
  }
  {
    const ctx = buildContext({
      document: { getElementById: id => (id === 'reopen-reason-inp' ? { value: 'Wrong closure by agent' } : null) },
      $id: id => ctx.document.getElementById(id)
    });
    ctx.borrowers = [{ id: 'loan-1', name: 'Alice', loan: 10000, prev: 10000, closed: true, completed: true, isInterest: false }];
    ctx.prompts = ['U001', 'WRONG-PIN'];
    vm.runInContext(functionSource('confirmReopenLoan'), ctx);
    await ctx.confirmReopenLoan('loan-1');
    check('wrong Admin PIN is rejected and the loan stays closed', ctx.borrowers[0].closed === true);
    check('wrong Admin PIN never adds an audit entry', ctx.entryLog.length === 0);
    check('wrong Admin PIN shows an explicit failure toast', (ctx.toasts || []).some(t => /PIN verification failed/.test(t)));
  }
  {
    const ctx = buildContext({
      document: { getElementById: id => (id === 'reopen-reason-inp' ? { value: 'Wrong closure by agent' } : null) },
      $id: id => ctx.document.getElementById(id)
    });
    ctx.borrowers = [{ id: 'loan-1', name: 'Alice', loan: 10000, prev: 6000, closed: true, completed: true, isInterest: false, remainingPrincipal: undefined }];
    ctx.prompts = ['U001', '1234'];
    vm.runInContext(functionSource('confirmReopenLoan'), ctx);
    await ctx.confirmReopenLoan('loan-1');
    const b = ctx.borrowers[0];
    check('correct PIN + reason reopens the loan (closed cleared)', b.closed === false && b.completed === false);
    check('existing balance (prev=6000) is preserved, not reset/recreated', b.prev === 6000);
    check('exactly one audit entry is appended, not zero and not duplicated', ctx.entryLog.length === 1);
    const entry = ctx.entryLog[0];
    check('audit entry records who authorized it', entry.reopenAuthorizedBy === 'U001');
    check('audit entry records the reason', entry.reopenReason === 'Wrong closure by agent');
    check('audit entry has a Date and a full Date/Time stamp', entry.reopenedDate === '2026-08-19' && typeof entry.reopenedAt === 'string' && entry.reopenedAt.length > 10);
    check('post-reopen refresh ran exactly once (no duplicate refresh)', ctx._refreshAfterLoanActionCalls === 1);
  }

  // ── behavioral checks: lhReopenLoan (Loan History page entry point) ────────
  {
    const ctx = buildContext({ prompt: () => null });
    ctx.borrowers = [{ id: 'loan-2', name: 'Bob', loan: 5000, prev: 5000, closed: true, isInterest: false }];
    vm.runInContext(functionSource('lhReopenLoan'), ctx);
    await ctx.lhReopenLoan('loan-2');
    check('Loan History reopen: cancelling the reason prompt leaves the loan closed', ctx.borrowers[0].closed === true);
  }
  {
    const ctx = buildContext();
    ctx.borrowers = [{ id: 'loan-2', name: 'Bob', loan: 5000, prev: 5000, closed: true, isInterest: false }];
    ctx.prompts = ['Duplicate closure entered by mistake', 'U001', '1234'];
    vm.runInContext(functionSource('lhReopenLoan'), ctx);
    await ctx.lhReopenLoan('loan-2');
    check('Loan History reopen: correct reason+PIN reopens the loan', ctx.borrowers[0].closed === false);
    check('Loan History reopen: writes the same audit contract as the Info-sheet flow', ctx.entryLog.length === 1 && ctx.entryLog[0].reopenAuthorizedBy === 'U001' && ctx.entryLog[0].reopenReason === 'Duplicate closure entered by mistake');
  }
  {
    // A permanently paid-off/closed loan must never be reopenable from either entry point.
    const ctxA = buildContext({
      document: { getElementById: id => (id === 'reopen-reason-inp' ? { value: 'attempt' } : null) },
      _isClosedPaidOffLoan: () => true
    });
    ctxA.$id = id => ctxA.document.getElementById(id);
    ctxA.borrowers = [{ id: 'loan-3', name: 'Carol', loan: 2000, prev: 2000, closed: true, completed: true, isInterest: false }];
    ctxA.prompts = ['U001', '1234'];
    vm.runInContext(functionSource('confirmReopenLoan'), ctxA);
    await ctxA.confirmReopenLoan('loan-3');
    check('paid-off/permanently-closed loan cannot be reopened via Info-sheet flow', ctxA.borrowers[0].closed === true && ctxA.entryLog.length === 0);
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
