'use strict';

// Regression test for the Borrower Details / Borrowers List weekly
// payment-status dot logic (the small 5-dot 🟢/🔴 row shown on each weekly
// regular-loan card, e.g. borrower ANNAPPA VEENA: "2/10 · 6wk" with dots
// under the phone number).
//
// Root cause: _weeklyPaymentDotStatuses computed ONE cumulative paidTotal
// across ALL of a borrower's valid payments (summed once, outside the loop),
// then for each of the 5 rendered weeks compared that SAME fixed total
// against a rising "cumulative amount that should have been paid by this
// week" threshold. Once a single missed/gap week pushed the required
// cumulative threshold above the (unchanging) total paid, EVERY subsequent
// week's check failed too — cascading every later week to red even when
// that week's own payment had genuinely, fully been collected. This is
// exactly what "Never derive weekly dots from transaction count/order"
// warns against: the dots depended on a running total, not on which
// specific scheduled week each payment's own date actually settles.
//
// Regression case (ANNAPPA VEENA): loan issued 11-Jul-2026 (a zero-amount
// opening/carried-forward entry, correctly excluded), Saturday collection,
// ₹1000/week. Real payments land on 18-Jul, 25-Jul, then a genuinely missed
// week (nothing paid for the cycle due 01-Aug), then 08-Aug (paid in full)
// and 15-Aug (only ₹500 of ₹1000 — partial). The old cumulative-threshold
// algorithm turned this into a wall of red dots after the gap, even for the
// 08-Aug week that was fully, on-time paid.
//
// Fix: every genuine (non-opening/non-top-up/non-zero) payment is bucketed
// by its OWN date into the ONE scheduled week window — (previous boundary,
// this boundary] — that date actually falls in, using the exact same
// "collection-day boundary belongs to the cycle it settles" convention the
// app already uses for interest-cycle allocation. Each of the 5 rendered
// weeks is then colored purely from its own bucket's total versus its own
// due amount (which mirrors the same remaining-balance cap the separate
// Paid Count calculation already uses, so a genuinely smaller final
// installment is never wrongly flagged red) — never from a shared running
// total, never from payment order/count. A single lump payment therefore
// settles only the one week its date belongs to; it can never reach forward
// or backward to repaint an unrelated week (that "chronological allocation"
// behavior was itself the same order-dependent anti-pattern being removed).

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
  effectiveBorrowerLoanType: borrower => borrower.loanType || 'weekly',
  borrowerWeeklyPayment: borrower => borrower.installment,
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
  }
};
vm.createContext(context);
vm.runInContext(extractFunction('_weeklyPaymentDotStatuses'), context);

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Original fixture: loandate 2026-07-08 (Wednesday), ₹600/week, no `loan`
// field set (installment-cap logic falls back to the flat installment). ────
const borrower = { id:'W-1', loanType:'weekly', loandate:'2026-07-08', installment:600 };
const statuses = records => Array.from(context._weeklyPaymentDotStatuses(borrower, records, '2026-08-12', 'Wednesday', 5));

eq('no payments: all five completed Wednesday cycles are unpaid', statuses([]), ['red','red','red','red','red']);

eq('a late payment settles only the week its own date falls in — never an earlier missed week',
  statuses([
    { id:'P-1', bid:'W-1', date:'2026-07-09', today:600 },
    { id:'P-2', bid:'W-1', date:'2026-07-30', today:600 }
  ]),
  ['green','red','red','green','red']);

eq('multiple partial payments inside the SAME week window combine into one fully-paid week',
  statuses([
    { id:'P-1', bid:'W-1', date:'2026-07-09', today:300 },
    { id:'P-2', bid:'W-1', date:'2026-07-15', today:300 }
  ]),
  ['green','red','red','red','red']);

eq('a single-dated advance payment settles only the one week its date belongs to (never spread across weeks by order)',
  statuses([{ id:'ADV', bid:'W-1', date:'2026-07-09', today:1800 }]),
  ['green','red','red','red','red']);

eq('duplicate saved IDs are counted once',
  statuses([
    { id:'DUP', bid:'W-1', date:'2026-07-09', today:600 },
    { id:'DUP', bid:'W-1', date:'2026-07-09', today:600 }
  ]),
  ['green','red','red','red','red']);

const beforeBoundary = Array.from(context._weeklyPaymentDotStatuses(borrower, [
  { id:'CURRENT', bid:'W-1', date:'2026-08-11', today:3600 }
], '2026-08-11', 'Wednesday', 5));
const completedOnly = Array.from(context._weeklyPaymentDotStatuses(borrower, [
  { id:'SETTLED', bid:'W-1', date:'2026-08-11', today:3000 }
], '2026-08-11', 'Wednesday', 5));
check('money for the incomplete current week cannot change a dot before its boundary', JSON.stringify(beforeBoundary) === JSON.stringify(completedOnly));

const newBorrower = { id:'W-2', loanType:'weekly', loandate:'2026-08-10', installment:600 };
eq('an incomplete first week remains not due even when paid early',
  Array.from(context._weeklyPaymentDotStatuses(newBorrower, [
    { id:'EARLY', bid:'W-2', date:'2026-08-10', today:600 }
  ], '2026-08-11', 'Wednesday', 5)),
  ['blank','blank','blank','blank','blank']);

eq('non-weekly workflows are untouched',
  Array.from(context._weeklyPaymentDotStatuses({ ...borrower, loanType:'monthly' }, [], '2026-08-12', 'Wednesday', 5)), []);

eq('legacy missing anchor: a payment still settles only its own actual due window, and another borrower\'s history is ignored',
  Array.from(context._weeklyPaymentDotStatuses({ id:'LEGACY', loanType:'weekly', installment:600 }, [
    { id:'OWN', bid:'LEGACY', date:'2026-08-01', today:600 },
    { id:'OTHER', bid:'OTHER', date:'2026-08-01', today:2400 }
  ], '2026-08-12', 'Wednesday', 5)),
  ['red','red','red','green','red']);

assert.match(extractFunction('_weekDots'), /_weeklyPaymentDotStatuses\(b,bEntries,todayStr\(\),_areaDay\(b\),5\)/, 'weekly card uses canonical dot projection');

// ── ANNAPPA VEENA regression: loan 11-Jul-2026 (Saturday), ₹1000/week,
// Saturday collection. A zero-amount opening/carried-forward entry, two
// genuinely on-time paid weeks, one genuinely MISSED week (no payment at
// all for that cycle), then a fully-paid week, then a PARTIAL week. ───────
{
  const b = { id:'ANNAPPA', loanType:'weekly', loandate:'2026-07-11', installment:1000 };
  const records = [
    { id:'OPEN', bid:'ANNAPPA', date:'2026-07-11', today:0, isOpeningBalance:true, isOpeningPaid:true, pay:'Opening Balance', note:'Carried forward', openingPaidAmount:0 },
    { id:'W1', bid:'ANNAPPA', date:'2026-07-18', today:1000 },
    { id:'W2', bid:'ANNAPPA', date:'2026-07-25', today:1000 },
    // (no entry at all for the cycle due 2026-08-01 — genuinely missed)
    { id:'W4', bid:'ANNAPPA', date:'2026-08-08', today:1000 },
    { id:'W5', bid:'ANNAPPA', date:'2026-08-15', today:500 }, // partial — not fully paid
  ];
  const result = Array.from(context._weeklyPaymentDotStatuses(b, records, '2026-08-15', 'Saturday', 5));
  eq('ANNAPPA VEENA regression: opening entry never occupies or colors a slot; genuinely paid weeks are green, the missed week is red without cascading, the partial week is red',
    result, ['green','green','red','green','red']);

  // De-duped zero/opening entries never leak into a bucket even if malformed
  // duplicates exist (defensive — matches the same seen-key de-dupe used
  // elsewhere in this function).
  const withDuplicateOpening = records.concat([{ id:'OPEN', bid:'ANNAPPA', date:'2026-07-11', today:0, isOpeningBalance:true, isOpeningPaid:true }]);
  eq('a duplicate opening-entry row does not change the result',
    Array.from(context._weeklyPaymentDotStatuses(b, withDuplicateOpening, '2026-08-15', 'Saturday', 5)), result);

  // ── Edited payment: dropping the 08-Aug payment down to a partial amount
  //    flips that week from green to red — dots are always recalculated
  //    fresh from the ledger, never trusting a stale/cached status. ───────
  const edited = records.map(e => e.id === 'W4' ? Object.assign({}, e, { today:400 }) : e);
  eq('editing a payment down to a partial amount recalculates that week to red',
    Array.from(context._weeklyPaymentDotStatuses(b, edited, '2026-08-15', 'Saturday', 5)),
    ['green','green','red','red','red']);

  // ── Deleted payment: removing the 18-Jul payment flips that week back to
  //    red, and nothing else shifts — deletion only affects its own week. ──
  const deleted = records.filter(e => e.id !== 'W1');
  eq('deleting a payment recalculates only its own week to red, others unaffected',
    Array.from(context._weeklyPaymentDotStatuses(b, deleted, '2026-08-15', 'Saturday', 5)),
    ['red','green','red','green','red']);

  // ── Loan-date change: moving the loan's start date two weeks later
  //    re-anchors the whole schedule — weeks that no longer exist before the
  //    new start become blank, and payments re-bucket against the new grid. ──
  const movedLoan = Object.assign({}, b, { loandate:'2026-07-25' });
  eq('changing the loan date re-anchors the schedule deterministically (earlier windows become blank)',
    Array.from(context._weeklyPaymentDotStatuses(movedLoan, records, '2026-08-15', 'Saturday', 5)),
    ['blank','blank','red','green','red']);
}

// ── Final-cycle reduced due amount: with the loan's `loan` amount set, a
//    nearly-paid-off loan's last real cycle owes LESS than a full flat
//    installment — a payment matching that smaller amount must still be
//    green, not red, mirroring the same remaining-balance cap the (separate)
//    Paid Count calculation already applies. ───────────────────────────────
{
  const b = { id:'TAIL', loanType:'weekly', loandate:'2026-07-11', installment:1000, loan:2500 };
  // cycle1 due 18-Jul: min(1000, 2500-0)=1000; cycle2 due 25-Jul: min(1000,2500-1000)=1000;
  // cycle3 due 01-Aug: min(1000, 2500-2000)=500 <- reduced final installment.
  const records = [
    { id:'C1', bid:'TAIL', date:'2026-07-18', today:1000 },
    { id:'C2', bid:'TAIL', date:'2026-07-25', today:1000 },
    { id:'C3', bid:'TAIL', date:'2026-08-01', today:500 },
  ];
  const result = Array.from(context._weeklyPaymentDotStatuses(b, records, '2026-08-01', 'Saturday', 3));
  eq('a reduced final-cycle due amount (loan nearly paid off) is correctly matched, not flagged red for being less than a full installment',
    result, ['green','green','green']);
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  failures: failed
}, null, 2));
if (failed.length) process.exitCode = 1;
