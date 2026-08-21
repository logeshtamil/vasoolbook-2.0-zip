'use strict';

// Verifies: (1) the Weekly/Monthly Payment Loan card badge shows only the bare
// "paid / total" count (the words "Weeks Paid" / "Months Paid" removed from the
// card, though the shared label function used elsewhere — e.g. Info sheet — is
// untouched); (2) a compact loan-age + status-dot indicator sits beside it,
// Weekly = elapsed weeks, Monthly = elapsed months, Start Date first priority
// falling back to Loan Date, green within the configured term / red once it is
// exceeded, and never shown for Interest Loans.

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

// ── card markup: bare count, no "Weeks Paid" wording, age badge present ────
const cardAnchor = source.indexOf('PERIOD CHIP: weekly/monthly regular loans only');
assert.ok(cardAnchor >= 0);
const cardSection = source.slice(cardAnchor, cardAnchor + 2200);
assert.ok(!cardSection.includes("Weeks Paid") && !cardSection.includes("Weeks' Paid"), 'the literal words "Weeks Paid" no longer appear in the card badge');
assert.match(cardSection, /_regularProgress\.paidCount\+' \/ '\+_regularProgress\.totalPeriods\+'<\/span>/, 'card badge shows the bare "paid / total" count format');
assert.match(cardSection, /_regularLoanAgeStatus\(b,todayStr\(\)\)/, 'card badge computes the loan-age status');
assert.match(cardSection, /_loanAge\.withinTerm\?'#1e7e34':'#c0392b'/, 'age badge is green within term, red once exceeded');
assert.match(cardSection, /_loanAge\.elapsed\+_loanAge\.unit/, 'age badge shows a compact elapsed count (e.g. "6wk"/"6mo") beside the paid count');

// ── calculation correctness ─────────────────────────────────────────────────
const context = {
  Date, Math, Object, String, Number, console,
  todayStr: () => '2026-08-12',
  effectiveBorrowerLoanType: b => b.loanType || 'weekly',
  isMonthlyType: lt => String(lt || '').toLowerCase().indexOf('monthly') >= 0,
  cfg: key => (key === 'weekly_period' ? '10' : key === 'monthly_period' ? '6' : ''),
  _dateOnly(value) {
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  },
  _localCalendarOrdinal(value) {
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }
};
vm.createContext(context);
[' loanTypeDefaultPeriod', '_regularLoanAgeStatus'].map(s => s.trim()).forEach(name => vm.runInContext(extractFunction(name), context));

(() => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // Weekly: loan started 2026-06-03 (a Wednesday), ref 2026-08-12 -> 10 weeks elapsed.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'weekly', loandate: '2026-06-03' }, '2026-08-12');
    check('weekly elapsed count is computed from Loan Date fallback', status.elapsed === 10, JSON.stringify(status));
    check('weekly within default 10-week term shows green (withinTerm)', status.withinTerm === true);
    check('unit is "wk" for weekly', status.unit === 'wk');
  }
  // Weekly, exceeded: 12 weeks elapsed against a 10-week term -> red.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'weekly', loandate: '2026-05-20' }, '2026-08-12');
    check('weekly loan exceeding the term (12 > 10 weeks) is flagged not-within-term', status.elapsed === 12 && status.withinTerm === false, JSON.stringify(status));
  }
  // Start Date takes priority over Loan Date when both are present.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'weekly', startDate: '2026-08-05', loandate: '2026-01-01' }, '2026-08-12');
    check('Start Date is used as first priority over Loan Date when present', status.elapsed === 1, JSON.stringify(status));
  }
  // Monthly: loan started 2026-02-10, ref 2026-08-12 -> 6 months elapsed (day 12 >= day 10).
  {
    const status = context._regularLoanAgeStatus({ loanType: 'monthly', loandate: '2026-02-10' }, '2026-08-12');
    check('monthly elapsed count uses calendar months since start', status.elapsed === 6, JSON.stringify(status));
    check('monthly within the configured 6-month term shows green', status.withinTerm === true);
    check('unit is "mo" for monthly', status.unit === 'mo');
  }
  // Monthly, configured term overrides default via b.period.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'monthly', loandate: '2026-01-10', period: 4 }, '2026-08-12');
    check('a configured loan term (period) overrides the settings default', status.term === 4 && status.withinTerm === false, JSON.stringify(status));
  }
  // Never shown for Interest Loans.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'monthly_interest', isInterest: true, loandate: '2026-01-10' }, '2026-08-12');
    check('Interest Loans never get a loan-age status (null)', status === null);
  }
  // No loan/start date at all -> null, not a crash or a misleading "0" age.
  {
    const status = context._regularLoanAgeStatus({ loanType: 'weekly' }, '2026-08-12');
    check('a loan with no date at all returns null rather than a false elapsed count', status === null);
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})();
