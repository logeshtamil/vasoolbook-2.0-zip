'use strict';

// Regression test for: "a new Account/Non-Account Transaction shows Saved
// successfully, but does not appear in the saved transaction list."
//
// Root cause: _datedAreaTxnBelongsToReport(t, reportDate, scopeAreas) — the
// single shared gate behind every NAT list/report/PDF/text-share surface —
// required an exact area match against scopeAreas (the set of areas whose
// configured Collection Day is today, auto-derived by
// _scheduledAreasForReportDate when no specific area filter is picked).
// A transaction saved with NO area selected (the "— Other / Not Specified —"
// option in the Add Transaction modal — the common case for petty cash,
// office expenses, and non-borrower entries) has t.area==='' / t.areaId===''
// and can never match any real area name, so it was silently dropped from
// dayNat on ANY day where at least one area's Collection Day happens to be
// today — which is true on most real days with an active book. The save
// itself (nonAccTxns.unshift + saveState()) always succeeded and the
// "✅ ... saved!" toast always fired, so the data was never lost — it was
// purely a read-time filtering bug, which is why it reproduced identically
// immediately after Save, after a tab switch, after a refresh, and after an
// app restart (the filter is pure and re-derives the same wrong answer from
// the same persisted data every time).
//
// Fix: an area-less transaction was never part of any area's scheduled
// collection round, so it must always be considered in-scope regardless of
// scopeAreas — while area-TAGGED transactions keep the exact same scoping
// behavior as before (still correctly excluded when their area isn't
// scheduled today, still correctly included when it is).

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

const context = {
  Object, Array, String, Number, Math, Boolean, Date, isFinite, JSON,
  todayStr: () => '2026-08-21', // a Friday
  _dateOnly(value) {
    const [y, m, d] = String(value || '').slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
  },
};
vm.createContext(context);
[
  '_normArea', '_areaId', '_areaName', '_areaKey', '_findAreaById', '_findAreaByName', '_findArea', '_entityAreaObj',
  '_areaIsUnderMain', '_areaMatchesValue', '_parentAreaId', '_looksMainAreaId', '_looksSubAreaId', '_looksAreaId',
  '_isMainArea', '_getAreaDay', '_findMainAreaByName', '_areaDayByName', '_dateDayName',
  '_scheduledAreasForReportDate', '_areaMatchesReportScope', '_datedAreaTxnBelongsToReport',
].forEach(name => vm.runInContext(extractFunction(name), context));

context.areas = [
  { areaId: '1001', name: 'Nehru Nagar', day: 'Friday' },   // scheduled today
  { areaId: '1002', name: 'M G Colony', day: 'Monday' },    // NOT scheduled today
];

const reportDate = '2026-08-21';
const scopeAreas = context._scheduledAreasForReportDate(reportDate, '');
assert.deepStrictEqual(scopeAreas, ['1001'], 'sanity: exactly one area is auto-scoped as scheduled today');

// ── 1. THE BUG: a Non-Account Transaction saved with no area selected
//    (Create -> Save, as saveNatTxn() actually constructs the record) must
//    appear in today's list — same day, no area filter applied. ──────────
const noAreaCashIn = { id: 'nat-1', date: reportDate, type: 'cash_in', amount: 500, name: 'Non-Borrower', area: '', areaId: '' };
assert.strictEqual(
  context._datedAreaTxnBelongsToReport(noAreaCashIn, reportDate, scopeAreas),
  true,
  'a saved area-less Cash In transaction appears in today\'s list (was: silently excluded)'
);

// Also covers "Account Transaction" types (acc_in/acc_out) — same function,
// same fix, same records array (nonAccTxns).
const noAreaAccOut = { id: 'nat-2', date: reportDate, type: 'acc_out', amount: 1200, name: 'Non-Borrower', area: '', areaId: '' };
assert.strictEqual(
  context._datedAreaTxnBelongsToReport(noAreaAccOut, reportDate, scopeAreas),
  true,
  'a saved area-less Acc Out (Account Transaction) appears in today\'s list (was: silently excluded)'
);

// ── 2. No regression: an area-TAGGED transaction whose area IS scheduled
//    today still appears (unchanged, correct behavior). ───────────────────
const scheduledAreaTxn = { id: 'nat-3', date: reportDate, type: 'cash_out', amount: 300, name: 'Ravi', area: 'Nehru Nagar', areaId: '1001' };
assert.strictEqual(
  context._datedAreaTxnBelongsToReport(scheduledAreaTxn, reportDate, scopeAreas),
  true,
  'an area-tagged transaction whose area is scheduled today still appears'
);

// ── 3. No regression: an area-TAGGED transaction whose area is NOT
//    scheduled today is still correctly excluded — the fix only bypasses
//    scoping for transactions with no area at all. ────────────────────────
const unscheduledAreaTxn = { id: 'nat-4', date: reportDate, type: 'cash_in', amount: 700, name: 'Suresh', area: 'M G Colony', areaId: '1002' };
assert.strictEqual(
  context._datedAreaTxnBelongsToReport(unscheduledAreaTxn, reportDate, scopeAreas),
  false,
  'an area-tagged transaction whose area is NOT scheduled today is still excluded (unchanged)'
);

// ── 4. No regression: date is still the primary gate — a transaction saved
//    for a different date never leaks into today's list, area notwithstanding.
const wrongDateTxn = { id: 'nat-5', date: '2026-08-20', type: 'cash_in', amount: 100, name: 'X', area: '', areaId: '' };
assert.strictEqual(
  context._datedAreaTxnBelongsToReport(wrongDateTxn, reportDate, scopeAreas),
  false,
  'a transaction saved for a different date never appears in today\'s list'
);

// ── 5. Source-level: every list/report/PDF/text-share surface routes
//    through the one fixed function — the fix covers all of them uniformly,
//    including the immediate post-Save render, refresh, tab switch, and
//    app restart (the filter is pure and re-derives from persisted data
//    identically every time, so fixing it here fixes every one of those). ──
const callSites = source.match(/_datedAreaTxnBelongsToReport\(/g) || [];
assert.ok(callSites.length >= 8, 'multiple report/list/share surfaces call the shared, now-fixed function: ' + callSites.length);

// ── 6. Source-level: the fix itself bypasses scoping only for records with
//    no area, and only after the date check — never weakens the date gate. ─
const fnSource = extractFunction('_datedAreaTxnBelongsToReport');
assert.match(fnSource, /if\(\(t\.date\|\|''\)!==reportDate\) return false;/, 'date is still checked first, unconditionally');
assert.match(fnSource, /if\(!\(t\.area\|\|t\.areaId\)\) return true;/, 'an area-less transaction always belongs to the report once its date matches');

// ── 7. Persistence: nonAccTxns (cm_nat) is included in both the write path
//    (_rawSaveStateFlushNow, used by saveState() -> saveNatTxn) and the read
//    path (loadState, used on refresh/app restart) — proves this is a pure
//    read-time filtering bug, not a storage bug, and that no other change is
//    needed to satisfy "Refresh -> Restart". ──────────────────────────────
const flushFnSource = extractFunction('_rawSaveStateFlushNow');
assert.match(flushFnSource, /cm_nat:\s*JSON\.stringify\(nonAccTxns\)/, 'nonAccTxns is written to durable storage on every saveState()');
const loadFnSource = extractFunction('loadState');
assert.match(loadFnSource, /nonAccTxns\s*=\s*nat\?JSON\.parse\(nat\):\[\]/, 'nonAccTxns is restored from durable storage on every load/restart');

// ── 8. saveNatTxn constructs area-less records exactly as fixture above
//    assumes ('' for both area and areaId when no area is selected) — keeps
//    this test honest against the real save path, not just its own fixture. ─
assert.match(source, /var bid=\$id\('nat-bid'\)\.value\|\|'';/, 'saveNatTxn reads the selected area exactly as this test assumes');
assert.match(source, /area:area,areaId:areaId,mainArea:/, 'saveNatTxn stamps area/areaId onto the saved record exactly as this test assumes');

console.log('NAT/Account Transaction list-visibility regression tests passed.');
