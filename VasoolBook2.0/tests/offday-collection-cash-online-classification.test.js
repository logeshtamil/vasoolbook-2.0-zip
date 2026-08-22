'use strict';

// Regression test for: "OffDay Collection → Collection Filter bug" —
// Cash Collection / Online must be derived purely from the saved payment
// mode, never inferred/whitelisted:
//   • Cash Collection = ONLY payments whose saved mode is exactly "Cash".
//   • Online = ALL non-Cash payments (GPay, PhonePe, UPI, Bank/Online, etc.)
//
// Root cause: _isOnlinePayEntry() classified "online" via a hardcoded
// keyword whitelist (_RPT_ONLINE_KW) and silently defaulted anything that
// did NOT match a keyword to "cash" — the opposite of the stated rule.
// GPay/PhonePe/UPI/Paytm/Bank Transfer/NEFT/Online were all covered by the
// whitelist and so happened to classify correctly already, but any mode
// NOT on that list (e.g. "Cheque", or any custom/future payment mode) fell
// through to "cash" by default, silently inflating Cash Collection and
// undercounting Online.
//
// Fix: _isOnlinePayEntry() now classifies purely by exact-match: Online =
// saved mode !== "Cash" (case-insensitive, trimmed). Only the non-split
// branch changed — the existing split-payment handling
// (isSplit → upiAmt>0) is untouched, and so is the separate loan-issuance
// classifier (_isOnlineLoanPay/_RPT_ONLINE_KW), which this bug report does
// not concern.

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

// ── 1. Source-level: exact-match classification, no keyword whitelist. ─────
const fnSrc = extractFunction('_isOnlinePayEntry');
assert.match(fnSrc, /pm\s*!==\s*'cash'/, 'classifies as online purely by "not exactly Cash", not a keyword whitelist');
assert.doesNotMatch(fnSrc, /_RPT_ONLINE_KW/, 'no longer depends on the incomplete online-keyword list');
assert.match(fnSrc, /if\(e\.isSplit\) return \(e\.upiAmt\|\|0\)>0;/, 'split-payment handling is untouched');

// The separate loan-issuance classifier (a different feature, not part of
// this bug report) still exists and still uses the keyword list — proves
// the fix did not touch it.
assert.match(source, /function _isOnlineLoanPay\(b\)\{[\s\S]{0,200}?_RPT_ONLINE_KW\.some/, '_isOnlineLoanPay (Loan Issues, unrelated to this bug) is untouched');
assert.match(source, /var _RPT_ONLINE_KW=\[/, '_RPT_ONLINE_KW itself still exists for the loan-issuance classifier');

// ── 2. Behavioral: mixed payment-mode entries, verified against real
//      extracted code — Cash filter, Online filter, and totals must match
//      exactly. ─────────────────────────────────────────────────────────────
function buildContext() {
  const context = {
    Object, Array, String, Number, Boolean, Date, Math, JSON,
    areas: [{ id: 'a1', name: 'Zone A', areaType: 'main', day: 'Wednesday' }],
    customers: [], borrowers: [],
    _findArea: v => { if (!v) return null; return context.areas.find(a => a.id === v || a.name === v) || null; },
    _findMainAreaByName: name => context.areas.find(a => a.name === name) || null,
    _getAreaDay: a => (a && a.day) || '',
    _areaMatchesValue: (entity, value) => { if (!value || value === 'All') return true; return (entity && entity.area) === value; },
    _areaIsUnderMain: () => true,
    _areaName: a => (a ? (typeof a === 'string' ? a : a.name) : ''),
    _dateOnly: s => { const p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); },
  };
  vm.createContext(context);
  const kwMarker = 'var _RPT_ONLINE_KW=';
  const kwStart = source.indexOf(kwMarker);
  const kwEnd = source.indexOf(';', kwStart);
  vm.runInContext(source.slice(kwStart, kwEnd + 1), context);
  ['_dateDayName', '_areaDayByName', '_entryAssignedCollectionDay', '_isHalfDayCollectionEntry', '_isOnlinePayEntry', '_halfDayCollectionEntries', '_calcHalfDayCollectionTotals']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

{
  const ctx = buildContext();
  // Zone A collects Wednesday; posting on Monday makes every entry an
  // off-day collection so all of them are in scope for the filter test.
  const d = '2026-08-24';
  const entryLog = [
    { date: d, area: 'Zone A', name: 'Cash Payer', pay: 'Cash', today: 1000 },
    { date: d, area: 'Zone A', name: 'GPay Payer', pay: 'GPay', today: 2000 },
    { date: d, area: 'Zone A', name: 'PhonePe Payer', pay: 'PhonePe', today: 1500 },
    { date: d, area: 'Zone A', name: 'UPI Payer', pay: 'UPI', today: 500 },
    { date: d, area: 'Zone A', name: 'BankTransfer Payer', pay: 'Bank Transfer', today: 700 },
    { date: d, area: 'Zone A', name: 'Cheque Payer', pay: 'Cheque', today: 250 }, // not in the old keyword whitelist
    { date: d, area: 'Zone A', name: 'CustomMode Payer', pay: 'Wallet App XYZ', today: 150 }, // never-seen-before mode
  ];
  ctx.entryLog = entryLog;

  const cashList = ctx._halfDayCollectionEntries(d, d, 'All', 'All', '', 'cash');
  const onlineList = ctx._halfDayCollectionEntries(d, d, 'All', 'All', '', 'online');

  check('Cash filter includes only the exact "Cash" payment', cashList.length === 1 && cashList[0].name === 'Cash Payer', JSON.stringify(cashList.map(e => e.name)));
  check('GPay is never classified as Cash', !cashList.some(e => e.pay === 'GPay') && onlineList.some(e => e.pay === 'GPay'));
  check('PhonePe is never classified as Cash', !cashList.some(e => e.pay === 'PhonePe') && onlineList.some(e => e.pay === 'PhonePe'));
  check('UPI is never classified as Cash', !cashList.some(e => e.pay === 'UPI') && onlineList.some(e => e.pay === 'UPI'));
  check('Bank Transfer is classified as Online', onlineList.some(e => e.pay === 'Bank Transfer'));
  check('Cheque (previously mis-bucketed via the incomplete whitelist) is now correctly Online, not Cash', !cashList.some(e => e.pay === 'Cheque') && onlineList.some(e => e.pay === 'Cheque'));
  check('An entirely unknown/custom payment mode also correctly defaults to Online (never silently counted as Cash)', !cashList.some(e => e.pay === 'Wallet App XYZ') && onlineList.some(e => e.pay === 'Wallet App XYZ'));
  check('Cash + Online lists partition all 7 entries with no overlap and no gaps', cashList.length + onlineList.length === entryLog.length);

  // ── Totals must match the filtered lists exactly. ──────────────────────
  const allList = ctx._halfDayCollectionEntries(d, d, 'All', 'All', '', 'all');
  const totals = ctx._calcHalfDayCollectionTotals(allList);
  const cashSum = cashList.reduce((s, e) => s + e.today, 0);
  const onlineSum = onlineList.reduce((s, e) => s + e.today, 0);
  check('Totals.cash matches the sum of the Cash-filtered list exactly', totals.cash === cashSum, `totals.cash=${totals.cash} cashSum=${cashSum}`);
  check('Totals.upi (Online) matches the sum of the Online-filtered list exactly', totals.upi === onlineSum, `totals.upi=${totals.upi} onlineSum=${onlineSum}`);
  check('Totals.cash is exactly 1000 (only the Cash payment)', totals.cash === 1000, 'got ' + totals.cash);
  check('Totals.upi is exactly 5100 (2000+1500+500+700+250+150)', totals.upi === 5100, 'got ' + totals.upi);
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  failures: failed,
}, null, 2));
if (failed.length) process.exitCode = 1;
