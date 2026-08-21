'use strict';

// Verifies the Monthly Payment Loan dot logic (the monthly counterpart to the
// already-tested weekly dots): dots represent only completed cycles in exact
// chronological order, the current incomplete month is never included, paid
// cycles are green and unpaid/partial cycles are red, duplicate saved payment
// IDs are never double-counted, and recomputing after an edit/delete (a pure
// function of the records array, no hidden mutable state) never leaves a
// stale/shifted dot.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const context = {
  Date, Math, Object, Array, String, Number, JSON, console,
  todayStr: () => '2026-08-12',
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'monthly',
  borrowerWeeklyPayment: borrower => borrower.installment,
  loanTypeDefaultPeriod: type => (type === 'monthly' ? 6 : 10),
  _borrowerAreaDay: () => 'Wednesday',
  _dateOnly(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  },
  _isoDate(value) {
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  },
  _localCalendarOrdinal(value) {
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  },
  _cycleMonthDate(startDate, monthsToAdd) {
    const [year, month, day] = String(startDate).slice(0, 10).split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1 + monthsToAdd, day));
    return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-');
  }
};
vm.createContext(context);
vm.runInContext(extractFunction('_regularPaymentCompletedPendingSummary'), context);

// Loan started 2026-02-10, ₹2000/month, monthly cycles boundaries at the 10th
// of each month: [Feb10-Mar10], [Mar10-Apr10], [Apr10-May10], [May10-Jun10],
// [Jun10-Jul10], [Jul10-Aug10] all complete by refDate 2026-08-12; [Aug10-Sep10]
// is the current, still-running cycle.
const borrower = { id: 'M-1', loanType: 'monthly', loandate: '2026-02-10', installment: 2000, loan: 12000 };
function summary(records, refDate) {
  return context._regularPaymentCompletedPendingSummary(borrower, refDate || '2026-08-12', records);
}
function dotsFrom(result, visibleCount) {
  const cycles = result.valid ? result.cycles : [];
  const visible = cycles.slice(-visibleCount);
  while (visible.length < visibleCount) visible.unshift(null);
  return visible.map(c => (!c ? 'blank' : (c.pending <= 0.01 ? 'green' : 'red')));
}

(() => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── current incomplete month is never included ──────────────────────────
  {
    const s = summary([]);
    check('current running month (Aug10-Sep10) is excluded from completed cycles', s.cycles.every(c => c.end <= '2026-08-12'));
    check('exactly 6 completed monthly cycles by 2026-08-12', s.cycles.length === 6);
  }

  // ── chronological order: first completed cycle is index 1, ascending ────
  {
    const s = summary([]);
    const idxs = s.cycles.map(c => c.idx);
    check('cycle indices are in exact ascending chronological order', JSON.stringify(idxs) === JSON.stringify([1, 2, 3, 4, 5, 6]));
    check('first cycle starts at the loan date', s.cycles[0].start === '2026-02-10');
  }

  // ── unpaid / fully paid / partial pending per cycle ──────────────────────
  {
    // Pay exactly the first 3 months in full, nothing after.
    const records = [
      { id: 'P1', bid: 'M-1', date: '2026-02-15', today: 2000 },
      { id: 'P2', bid: 'M-1', date: '2026-03-12', today: 2000 },
      { id: 'P3', bid: 'M-1', date: '2026-04-11', today: 2000 }
    ];
    const s = summary(records);
    const dots = dotsFrom(s, 6);
    check('fully paid months are green, unpaid months are red, chronological (no shift)',
      JSON.stringify(dots) === JSON.stringify(['green', 'green', 'green', 'red', 'red', 'red']), JSON.stringify(dots));
  }

  // ── partial payment leaves a cycle red (not green) ───────────────────────
  {
    const records = [
      { id: 'P1', bid: 'M-1', date: '2026-02-15', today: 1200 } // only 1200 of 2000 due for month 1
    ];
    const s = summary(records);
    const dots = dotsFrom(s, 6);
    check('a partially-paid month stays red, not green', dots[0] === 'red', JSON.stringify(dots));
  }

  // ── duplicate saved payment IDs are never double-counted ─────────────────
  {
    const records = [
      { id: 'DUP', bid: 'M-1', date: '2026-02-15', today: 2000 },
      { id: 'DUP', bid: 'M-1', date: '2026-02-15', today: 2000 }
    ];
    const s = summary(records);
    check('duplicate saved payment IDs are counted once, not twice', s.paidTotal === 2000, String(s.paidTotal));
    const dots = dotsFrom(s, 6);
    check('duplicate-ID payment settles exactly one month, not two', dots[0] === 'green' && dots[1] === 'red', JSON.stringify(dots));
  }

  // ── fewer completed cycles than the visible dot count pads with blanks at the front ──
  {
    const youngBorrower = { id: 'M-2', loanType: 'monthly', loandate: '2026-06-10', installment: 2000, loan: 12000 };
    const s = context._regularPaymentCompletedPendingSummary(youngBorrower, '2026-08-12', []);
    const cycles = s.valid ? s.cycles : [];
    const visible = cycles.slice(-6); while (visible.length < 6) visible.unshift(null);
    const dots = visible.map(c => (!c ? 'blank' : (c.pending <= 0.01 ? 'green' : 'red')));
    check('a young loan with only 2 completed cycles pads blanks at the front, real dots stay last (chronological)',
      JSON.stringify(dots) === JSON.stringify(['blank', 'blank', 'blank', 'blank', 'red', 'red']), JSON.stringify(dots));
  }

  // ── edit/delete/refresh: this is a pure function of the records array — no
  // hidden mutable cache inside it, so deleting a payment and recomputing must
  // immediately reflect the new (correct) state, never a stale green dot ────
  {
    const paidRecords = [{ id: 'P1', bid: 'M-1', date: '2026-02-15', today: 2000 }];
    const beforeDelete = dotsFrom(summary(paidRecords), 6);
    const afterDelete = dotsFrom(summary([]), 6);
    check('deleting the only payment immediately flips its dot back to red on recompute (no stale state)',
      beforeDelete[0] === 'green' && afterDelete[0] === 'red', JSON.stringify({ beforeDelete, afterDelete }));

    const editedRecords = [{ id: 'P1', bid: 'M-1', date: '2026-02-15', today: 900 }]; // edited down below the due amount
    const afterEdit = dotsFrom(summary(editedRecords), 6);
    check('editing a payment amount down immediately reflects on recompute (dot turns red again)', afterEdit[0] === 'red', JSON.stringify(afterEdit));
  }

  // ── the shared card renderer (_weekDots) wires the monthly branch to this
  // exact canonical summary function, not a separate/duplicate calculation ──
  const weekDotsSrc = extractFunction('_weekDots');
  check('_weekDots monthly branch is sourced from _regularPaymentCompletedPendingSummary (one canonical calculation, no duplicate logic)',
    /_regularPaymentCompletedPendingSummary\(b,todayStr\(\),bEntries\)/.test(weekDotsSrc));
  check('_weekDots monthly branch excludes Interest Loans (dots are Weekly/Monthly Payment Loan only)',
    /!b\.isInterest&&isMonthly/.test(weekDotsSrc));
  check('_weekDots monthly branch slices to the last 5 completed cycles, most recent last (chronological)',
    /_completedCycles\.slice\(-5\)/.test(weekDotsSrc));

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})();
