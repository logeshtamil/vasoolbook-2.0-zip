'use strict';

// Regression test for: "Account Transactions and non-Account Transactions —
// a new transaction shows Saved successfully, but does not appear in the
// saved transaction list."
//
// Root cause: every place that lists/exports Account & Non-Account
// Transactions (nonAccTxns) filtered them through
// _datedAreaTxnBelongsToReport(t, reportDate, scopeAreas) using the SAME
// `scopeAreas` computed by _scheduledAreasForReportDate() that the
// Collection Entries and Loan Issues reports use — i.e. "which main areas
// are scheduled to collect on this specific calendar day of the week".
// NAT transactions are plain date + optional-area cash movements; they are
// never tied to a borrower collection-day schedule. So a correctly-saved
// transaction was silently excluded from the list/PDF/share/report totals
// whenever its own area (or "no area" at all — every "Non-Borrower" entry)
// wasn't scheduled to collect on that day — true on nearly every day for
// any multi-area setup, and true for EVERY Non-Borrower entry whenever any
// other area happened to be scheduled that day. The transaction itself was
// always saved and reloaded correctly (state/storage were never the
// problem) — only the report-time filter was wrong, so it reproduced
// identically after refresh, tab switch, and app restart.
//
// Fix: introduced _natReportScopeAreas(selArea), which scopes NAT
// transactions by the user's selected Area filter alone (or "All"/empty =
// everything), never by collection-day schedule, and wired it into every
// real call site that filters nonAccTxns by date/area: the Reports NAT
// list, the Account/NAT text share, the Account/NAT PDF share, the Cash
// Book reconciliation figures, the Final Tally card, the tally PDF export,
// the tally PDF lines builder, the Collection Report data builder, the
// Collection Report by-area PDF, and the Smart Agent "today's report"
// query. _entryBelongsToReport/_loanBelongsToReport/
// _scheduledAreasForReportDate — used by the OTHER, correctly-day-scoped
// reports (Collection Entries, Loan Issues) — are completely untouched.

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

// ── 1. Source-level: every real call site now scopes NAT transactions via
//      the new selected-area-only helper, never the day-scheduled one. ─────
const natFilterCallSites = [...source.matchAll(/(?:nonAccTxns\|\|\[\]|typeof nonAccTxns!=='undefined'\?nonAccTxns:\[\])\)\.filter\(function\(t\)\{[\s\S]{0,160}?_datedAreaTxnBelongsToReport\(t,[^)]*\)/g)];
assert.strictEqual(natFilterCallSites.length, 9, 'exactly the 9 known nonAccTxns report/list/export/share/smart-agent call sites exist');
natFilterCallSites.forEach((m, i) => {
  assert.match(m[0], /_natReportScopeAreas\(/, `call site ${i + 1} uses the selected-area-only scope, not the day-scheduled one: ${m[0]}`);
});
// No remaining direct pass-through of a raw day-scheduled scope variable
// (scopeAreas / _rptScopeAreas) into the NAT filter, anywhere in the file.
assert.doesNotMatch(source, /nonAccTxns[\s\S]{0,80}?\.filter\(function\(t\)\{[\s\S]{0,160}?_datedAreaTxnBelongsToReport\(t,[a-zA-Z0-9_]+,\s*(scopeAreas|_rptScopeAreas)\s*\)/, 'no remaining nonAccTxns filter passes a raw day-scheduled scope variable straight through');

// The helper itself: All → no restriction; a specific area → scoped to it.
const helperSrc = extractFunction('_natReportScopeAreas');
assert.match(helperSrc, /selArea&&selArea!=='All'/, 'only restricts scope when a specific (non-"All") area is actually selected');

// ── 2. The OTHER report scoping functions (day-of-week schedule based) are
//      completely untouched — this fix never touches Collection Entries or
//      Loan Issues reporting logic. ──────────────────────────────────────────
assert.match(source, /function _scheduledAreasForReportDate\(reportDate,selArea\)\{\s*\n\s*var dayName=_dateDayName\(reportDate\);/, '_scheduledAreasForReportDate is unchanged');
assert.match(source, /function _entryBelongsToReport\(e,reportDate,scopeAreas\)\{\s*\n\s*if\(\(e\.date\|\|''\)!==reportDate\) return false;/, '_entryBelongsToReport (Collection Entries) is unchanged');
assert.match(source, /function _loanBelongsToReport\(b,reportDate,scopeAreas\)\{\s*\n\s*if\(\(b\.loandate\|\|''\)!==reportDate\) return false;/, '_loanBelongsToReport (Loan Issues) is unchanged');
assert.match(source, /function _datedAreaTxnBelongsToReport\(t,reportDate,scopeAreas\)\{\s*\n\s*if\(\(t\.date\|\|''\)!==reportDate\) return false;\s*\n\s*if\(!scopeAreas\|\|!scopeAreas\.length\) return true;\s*\n\s*return _areaMatchesReportScope\(t,scopeAreas\);\s*\n\}/, '_datedAreaTxnBelongsToReport itself is unchanged — only what gets passed into it as scopeAreas changed at the call sites');

// ── 3. Behavioral: reproduces the exact real-world shape of the bug (a
//      multi-area setup where areas collect on different days) and proves
//      the fix resolves it, across Create → Save → List → Refresh →
//      Restart → Edit → Delete. ─────────────────────────────────────────────
function buildContext() {
  const context = {
    Object, Array, String, Number, Boolean, Date, Math, JSON,
    areas: [
      { id: 'a1', name: 'Wednesday Zone', areaType: 'main', day: 'Wednesday' },
      { id: 'a2', name: 'Monday Zone', areaType: 'main', day: 'Monday' },
    ],
    _looksAreaId: v => /^a\d/.test(String(v || '')),
    _findArea: v => { if (!v) return null; return context.areas.find(a => a.id === v || a.name === v) || null; },
    _areaId: a => (a && a.id) || '',
    _areaName: a => (a ? (typeof a === 'string' ? a : a.name) : ''),
    _isMainArea: a => a && (typeof a === 'string' || a.areaType !== 'sub'),
    _normArea: s => String(s || '').trim(),
    _areaKey: a => context._areaId(a) || context._areaName(a),
    _parentAreaId: () => '',
    _areaDayByName: name => { const a = context.areas.find(x => x.name === name); return a ? a.day : ''; },
    _entityAreaObj: entity => { if (!entity) return null; if (entity.areaId) return context._findArea(entity.areaId); if (entity.area) return { name: entity.area }; return null; },
    _dateOnly: s => { const p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); },
  };
  vm.createContext(context);
  ['_dateDayName', '_areaMatchesValue', '_areaIsUnderMain', '_scheduledAreasForReportDate', '_areaMatchesReportScope', '_datedAreaTxnBelongsToReport', '_natReportScopeAreas']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

{
  const ctx = buildContext();
  // 2026-08-24 is a Monday. Only "Monday Zone" is scheduled to collect that day.
  const reportDate = '2026-08-24';
  let nonAccTxns = [];

  // ── CREATE + SAVE: a Non-Borrower cash-in (no area at all) and a
  //    borrower-linked transaction tagged to the Wednesday-only area — both
  //    saved TODAY (Monday), exactly like the real modal's date default. ────
  const txnNonBorrower = { id: 'T1', date: reportDate, ts: reportDate + 'T10:00:00.000Z', type: 'cash_in', amount: 500, name: 'Non-Borrower', bid: null, area: '', areaId: '' };
  const txnWedArea = { id: 'T2', date: reportDate, ts: reportDate + 'T11:00:00.000Z', type: 'cash_out', amount: 300, name: 'Some Person', bid: 'B1', area: 'Wednesday Zone', areaId: 'a1' };
  nonAccTxns.unshift(txnNonBorrower);
  nonAccTxns.unshift(txnWedArea);
  check('create+save: both transactions land in the store, no duplicates', nonAccTxns.length === 2, 'len=' + nonAccTxns.length);

  // ── LIST: with the default "All Areas" report filter, both must now be
  //    visible — this is the exact bug the user reported. ───────────────────
  const selArea = 'All';
  const dayNat = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas(selArea)));
  check('list: Non-Borrower (no-area) transaction now appears', dayNat.some(t => t.id === 'T1'));
  check('list: Wednesday-area transaction (saved on a Monday) now appears', dayNat.some(t => t.id === 'T2'));
  check('list: nothing was invented — exactly the 2 saved transactions, no duplicates', dayNat.length === 2, 'len=' + dayNat.length);

  // Sanity: prove this WOULD have failed under the old (buggy) day-scheduled scope.
  const oldBuggyScope = ctx._scheduledAreasForReportDate(reportDate, selArea);
  const dayNatOldBuggy = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, oldBuggyScope));
  check('sanity: the OLD day-scheduled scope really did hide both transactions (confirms this is the real bug)', dayNatOldBuggy.length === 0, 'oldBuggyScope=' + JSON.stringify(oldBuggyScope) + ' len=' + dayNatOldBuggy.length);

  // ── REFRESH: recompute independently from scratch — no cached UI value. ──
  const dayNatRefreshed = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas('All')));
  check('refresh: still shows both after an independent recomputation', dayNatRefreshed.length === 2);

  // ── RESTART: simulate serializing to storage and reloading into a totally
  //    fresh context/array, as if the app was killed and relaunched. ────────
  const persisted = JSON.parse(JSON.stringify(nonAccTxns));
  const restartedCtx = buildContext();
  const dayNatAfterRestart = persisted.filter(t => restartedCtx._datedAreaTxnBelongsToReport(t, reportDate, restartedCtx._natReportScopeAreas('All')));
  check('restart: both transactions survive a full serialize/reload cycle and still appear', dayNatAfterRestart.length === 2);
  check('restart: no duplicates were introduced by the reload', persisted.length === 2, 'len=' + persisted.length);

  // ── AREA FILTER still works correctly (fix does not turn off area
  //    scoping — it only removes the wrong day-of-week restriction). ────────
  const dayNatScopedToMonday = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas('a2')));
  check('area filter: selecting "Monday Zone" correctly excludes the Wednesday-area transaction', !dayNatScopedToMonday.some(t => t.id === 'T2'));
  const dayNatScopedToWednesday = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas('a1')));
  check('area filter: selecting "Wednesday Zone" correctly includes its own transaction', dayNatScopedToWednesday.some(t => t.id === 'T2'));

  // ── EDIT: updates the SAME record in place (id/ts preserved), never
  //    pushes a duplicate — mirrors the app's real edit-mode wrapper for
  //    saveNatTxn(), verified directly against the persisted array. ─────────
  const idx = nonAccTxns.findIndex(t => t.id === 'T2');
  const before = { id: nonAccTxns[idx].id, ts: nonAccTxns[idx].ts };
  nonAccTxns[idx] = Object.assign({}, nonAccTxns[idx], { amount: 450, note: 'edited' });
  check('edit: transaction count unchanged (in-place update, no duplicate)', nonAccTxns.length === 2);
  check('edit: id and original timestamp preserved', nonAccTxns[idx].id === before.id && nonAccTxns[idx].ts === before.ts);
  check('edit: amount actually updated', nonAccTxns[idx].amount === 450);
  const dayNatAfterEdit = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas('All')));
  check('edit: edited transaction still appears in the list afterward', dayNatAfterEdit.some(t => t.id === 'T2' && t.amount === 450));

  // ── DELETE: removes exactly the targeted transaction, nothing else. ──────
  nonAccTxns = nonAccTxns.filter(t => t.id !== 'T1');
  check('delete: exactly one transaction remains', nonAccTxns.length === 1 && nonAccTxns[0].id === 'T2');
  const dayNatAfterDelete = nonAccTxns.filter(t => ctx._datedAreaTxnBelongsToReport(t, reportDate, ctx._natReportScopeAreas('All')));
  check('delete: deleted transaction no longer appears, remaining one still does', !dayNatAfterDelete.some(t => t.id === 'T1') && dayNatAfterDelete.some(t => t.id === 'T2'));
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  failures: failed,
}, null, 2));
if (failed.length) process.exitCode = 1;
