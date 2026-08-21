'use strict';

// Verifies the new Interest Loan Payment Reminder format (WhatsApp/Copy/Share
// only) for both Monthly and Weekly Interest Loans:
//   - exact clean format, header text differs only by loan type
//   - Period / Due Date / Due Amount always come from the exact PAYABLE
//     COMPLETED cycle, never a running/incomplete one — this is the actual
//     behavioral fix: getInterestCycleCalculation already guaranteed this for
//     monthly, but NOT for weekly (br.cycleStart/currentDue reflected the
//     running cycle for weekly loans before this fix)
//   - previous pending (if any) is folded into a single Due Amount figure
//   - the old "Your Payment is pending..." wording is completely gone
//   - name/area/heading/closing line are Unicode-bold; Loan Amount/Period/Due
//     Date/Due Amount labels are auto-bolded by the existing
//     _messageBoldLabels pipeline; values stay plain

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

function boldUnicode(text) {
  return String(text || '').replace(/[A-Za-z]/g, ch => {
    const code = ch.charCodeAt(0);
    return String.fromCodePoint(code >= 65 && code <= 90 ? 0x1D400 + (code - 65) : 0x1D41A + (code - 97));
  });
}

// fmtDate/fmtDateSlash go through _displayDateParts, whose real body contains
// regex quantifiers with braces (\d{4}, \d{2}) that the simple brace-depth
// extractor above cannot parse (it only tracks string/template-literal
// quotes, not regex literals). Both are re-implemented here faithfully for
// plain 'YYYY-MM-DD' input — the only shape this test's fixtures ever use —
// verified against the real source's month-abbreviation table and separator
// choice below, so the actual business logic under test
// (_interestDueReminderMessage, _monthlyInterestPayableSummary,
// _messageBoldUnicode, _messageBoldLabels) is still exercised for real.
assert.match(source, /function fmtDate\(s\)\{[\s\S]{0,400}?String\(p\.day\)\.padStart\(2,'0'\)\+'-'\+months\[p\.month-1\]\+'-'\+String\(p\.year\)\.padStart\(4,'0'\)/, 'fmtDate source shape unchanged (stub below stays faithful)');
assert.match(source, /function fmtDateSlash\(s\)\{[\s\S]{0,200}?String\(p\.day\)\.padStart\(2,'0'\)\+'\/'\+String\(p\.month\)\.padStart\(2,'0'\)\+'\/'\+String\(p\.year\)\.padStart\(4,'0'\)/, 'fmtDateSlash source shape unchanged (stub below stays faithful)');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoParts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

const context = {
  Object, Number, Math, isFinite, String, Array, JSON, console,
  cfg: () => '',
  isBorrowerMonthlyType: b => b && b.loanType === 'monthly_interest',
  todayStr: () => '2026-07-22',
  fmtDate(s) { const p = isoParts(s); if (!p) return ''; return String(p.day).padStart(2, '0') + '-' + MONTHS[p.month - 1] + '-' + String(p.year).padStart(4, '0'); },
  fmtDateSlash(s) { const p = isoParts(s); if (!p) return ''; return String(p.day).padStart(2, '0') + '/' + String(p.month).padStart(2, '0') + '/' + String(p.year).padStart(4, '0'); },
};
vm.createContext(context);
[
  '_messageBoldUnicode', '_messageBoldLabels',
  '_monthlyInterestPayableSummary', '_interestDueReminderMessage',
].forEach(name => vm.runInContext(extractFunction(name), context));
// applyMessageTemplate's real body contains a regex literal with braces
// (/\{\{\s*message\s*\}\}/) that the brace-depth extractor above cannot
// parse (it only tracks string/template-literal quotes, not regex spans).
// Stand in with its verified default-path behavior instead: with no custom
// template configured (the untouched-install state this reminder format
// targets), applyMessageTemplate reduces exactly to _messageBoldLabels(msg)
// — confirmed by reading its source (`if(!tpl||!tpl.body||tpl.body==='{{message}}')return _messageBoldLabels(msg);`,
// which is the only branch reached when zero custom templates exist).
assert.ok(source.includes("if(!tpl||!tpl.body||tpl.body==='{{message}}')return _messageBoldLabels(msg);"), 'applyMessageTemplate default-path source shape is unchanged (stub below stays faithful)');
context.applyMessageTemplate = (type, msg) => context._messageBoldLabels(msg);

// ── Fixture: a monthly interest borrower with ONE completed cycle (22 Jun -
// 22 Jul, ₹600 due, fully unpaid) AND a running/incomplete cycle (22 Jul - 22
// Aug) already accruing. getInterestCycleCalculation's real output shape is
// mimicked directly (established pattern in this codebase's other reminder/
// receipt tests) rather than exercising the full interest-math engine —
// _interestDueReminderMessage's contract is "given a br object shaped like
// getInterestCycleCalculation's output, build this exact message."
const monthlyBorrower = { id: 'IL-1', name: 'h d chandra lakshmi', area: 'm. g colony', loanType: 'monthly_interest', isInterest: true, principalAmt: 10000, loan: 10000 };
const monthlyBr = {
  calculationVersion: 1, refDate: '2026-07-22',
  cycleStart: '2026-07-22', cycleEnd: '2026-08-22', // RUNNING cycle — must never appear in the message
  currentDue: 50, previousPendingDue: 0, totalDue: 650,
  cycles: [
    { idx: 1, start: '2026-06-22', end: '2026-07-22', gross: 600, paid: 0, pending: 600 }, // completed, payable
    { idx: 2, start: '2026-07-22', end: '2026-08-22', gross: 600, paid: 0, pending: 50 },  // running/incomplete
  ],
};

const monthlyMsg = context._interestDueReminderMessage(monthlyBorrower, monthlyBr);
const monthlyLines = monthlyMsg.split('\n');

assert.deepStrictEqual(monthlyLines, [
  '👤 ' + boldUnicode('h d chandra lakshmi') + ',',
  '📍 ' + boldUnicode('m. g colony'),
  '',
  '📢 ' + boldUnicode('Monthly Due Amount Reminder'),
  '💰 ' + boldUnicode('Loan Amount') + ': ₹10,000',
  '📅 ' + boldUnicode('Period') + ': 22/06/2026 to 22/07/2026',
  '📆 ' + boldUnicode('Due Date') + ': 22-Jul-2026',
  '💳 ' + boldUnicode('Due Amount') + ': ₹600',
  '',
  '🙏 ' + boldUnicode('Kindly arrange the due payment.'),
  '',
], 'monthly reminder matches the exact requested format:\n' + monthlyMsg);

assert.ok(!/22\/07\/2026 to 22\/08\/2026/.test(monthlyMsg), 'the running cycle (Jul 22 - Aug 22) must never appear in the reminder');
assert.ok(!/₹650|₹50\b/.test(monthlyMsg), 'the running cycle prorated amount (₹50) and its total (₹650) must never appear');
assert.ok(!/pending/i.test(monthlyMsg), 'the old "Your Payment is pending..." wording is completely removed');

// ── Weekly interest loan: heading changes, same completed-cycle-only rule.
// This is the actual regression case — before the fix, weekly reminders used
// br.cycleStart/br.currentDue directly, which reflect the RUNNING cycle.
const weeklyBorrower = { id: 'IL-2', name: 'Ravi Kumar', area: 'Nehru Nagar', loanType: 'weekly_interest', isInterest: true, principalAmt: 5000, loan: 5000 };
const weeklyBr = {
  calculationVersion: 1, refDate: '2026-07-22',
  cycleStart: '2026-07-16', cycleEnd: '2026-07-23', // running cycle per getInterestCycleCalculation's weekly path
  currentDue: 40, previousPendingDue: 0, totalDue: 40,
  cycles: [
    { idx: 4, start: '2026-07-02', end: '2026-07-09', gross: 100, paid: 100, pending: 0 },   // completed, paid
    { idx: 5, start: '2026-07-09', end: '2026-07-16', gross: 100, paid: 0, pending: 100 },   // completed, payable
    { idx: 6, start: '2026-07-16', end: '2026-07-23', gross: 100, paid: 0, pending: 40 },    // running/incomplete
  ],
};
const weeklyMsg = context._interestDueReminderMessage(weeklyBorrower, weeklyBr);
assert.ok(weeklyMsg.includes(boldUnicode('Weekly Due Amount Reminder')), 'weekly heading is used for a weekly interest loan');
assert.ok(!weeklyMsg.includes(boldUnicode('Monthly Due Amount Reminder')), 'monthly heading never appears for a weekly loan');
assert.ok(weeklyMsg.includes('09/07/2026 to 16/07/2026'), 'weekly Period comes from the completed cycle (Jul 9-16), not the running one');
assert.ok(weeklyMsg.includes('16-Jul-2026'), 'weekly Due Date is the completed cycle end, not the running cycle end (23-Jul-2026)');
assert.ok(!weeklyMsg.includes('23-Jul-2026'), 'the running cycle end date must never appear as the Due Date');
assert.ok(weeklyMsg.includes('₹100'), 'weekly Due Amount is the completed cycle pending (₹100), not the running cycle prorated amount (₹40)');
assert.ok(!/₹40\b/.test(weeklyMsg), 'the running cycle prorated amount must never appear as the Due Amount');

// ── Previous pending is folded into a single Due Amount, per existing logic
// (no separate "Previous Pending"/"Total Due" lines in this format).
const withPrevPending = {
  calculationVersion: 1, refDate: '2026-08-22',
  cycleStart: '2026-08-22', cycleEnd: '2026-09-22', currentDue: 10, previousPendingDue: 600, totalDue: 610,
  cycles: [
    { idx: 1, start: '2026-06-22', end: '2026-07-22', gross: 600, paid: 0, pending: 600 },
    { idx: 2, start: '2026-07-22', end: '2026-08-22', gross: 600, paid: 0, pending: 600 }, // latest completed cycle
    { idx: 3, start: '2026-08-22', end: '2026-09-22', gross: 600, paid: 0, pending: 10 },  // running
  ],
};
const prevPendingMsg = context._interestDueReminderMessage(monthlyBorrower, withPrevPending);
assert.ok(prevPendingMsg.includes('₹1,200'), 'Due Amount correctly folds the previous pending cycle (₹600) into the current payable cycle (₹600) = ₹1,200: ' + prevPendingMsg);
assert.ok(!/Previous Pending|Total Due/i.test(prevPendingMsg), 'no separate Previous Pending / Total Due lines in the new format');

// ── Company/signature line only appears when configured, and is bold too.
const withCompany = context._interestDueReminderMessage(Object.assign({}, monthlyBorrower, { bank: 'Sri Lakshmi Finance' }), monthlyBr);
assert.ok(withCompany.trim().endsWith(boldUnicode('Sri Lakshmi Finance')), 'company/signature line is appended in bold when configured');

// ── Values (money, dates) stay in plain characters — only labels/name/area/
// heading/closing are converted to bold Unicode.
assert.ok(monthlyMsg.includes('₹10,000') && monthlyMsg.includes('₹600'), 'money values remain plain, unconverted digits');
assert.ok(monthlyMsg.includes('22/06/2026') && monthlyMsg.includes('22-Jul-2026'), 'date values remain in plain digits');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'exact-monthly-format-match',
    'running-cycle-never-leaks-into-monthly-message',
    'old-pending-wording-removed',
    'weekly-heading-used-for-weekly-loan',
    'weekly-period-due-date-amount-from-completed-cycle-not-running',
    'previous-pending-folded-into-single-due-amount',
    'no-separate-previous-pending-total-due-lines',
    'company-signature-line-when-configured',
    'values-stay-plain-only-labels-bold',
  ],
}, null, 2));
