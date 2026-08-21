'use strict';

// Verifies the new Collection Entries checkbox filters (Cash / Online /
// Fully Closed) — combinable, recalculating totals from only the filtered
// entries, reusing the existing pay-mode pipeline and _entryMarksPermanentClosure
// (no duplicated calculation logic), without touching the Loan Issues card's
// own separate pm-all/pm-cash/pm-online buttons.

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

// ── 1. HTML: checkboxes exist on the entries card; the old pay-mode BUTTONS
//    are gone from the entries card specifically, but the Loan Issues card's
//    own pm-buttons are completely untouched (separate section, unaffected). ─
{
  const entriesCardStart = source.indexOf('id="rpt-entries-card"');
  const entriesSearchBarStart = source.indexOf('id="rpt-entries-search-bar"', entriesCardStart);
  const entriesSearchBarEnd = source.indexOf('rpt-entries-search-count', entriesSearchBarStart);
  const entriesBarHtml = source.slice(entriesSearchBarStart, entriesSearchBarEnd);
  assert.ok(entriesBarHtml.includes('id="rpt-entries-chk-cash"') && entriesBarHtml.includes('type="checkbox"'), 'Cash checkbox present on the entries card');
  assert.ok(entriesBarHtml.includes('id="rpt-entries-chk-online"'), 'Online checkbox present on the entries card');
  assert.ok(entriesBarHtml.includes('id="rpt-entries-chk-closed"'), 'Fully Closed checkbox present on the entries card');
  assert.ok(!entriesBarHtml.includes('id="rpt-entries-pm-all"') && !entriesBarHtml.includes('id="rpt-entries-pm-cash"'), 'old pay-mode buttons removed from the entries card (replaced by checkboxes)');

  const loansCardStart = source.indexOf('id="rpt-loans-card"');
  const loansSearchBarStart = source.indexOf('id="rpt-loans-search-bar"', loansCardStart);
  const loansSearchBarEnd = source.indexOf('rpt-loans-search-count', loansSearchBarStart);
  const loansBarHtml = source.slice(loansSearchBarStart, loansSearchBarEnd);
  assert.ok(loansBarHtml.includes('id="rpt-loans-pm-all"') && loansBarHtml.includes('id="rpt-loans-pm-cash"') && loansBarHtml.includes('id="rpt-loans-pm-online"'), 'Loan Issues card keeps its own existing pay-mode buttons completely untouched');
}

// ── 2. onRptEntriesFilterCheckboxChange: mode resolution + reuse of the
//    existing setRptPayMode pipeline (no duplicated calculation). ─────────
{
  const calls = [];
  const boxes = { 'rpt-entries-chk-cash': { checked: false }, 'rpt-entries-chk-online': { checked: false }, 'rpt-entries-chk-closed': { checked: false } };
  const context = {
    $id: id => boxes[id] || null,
    setRptPayMode: (section, mode) => calls.push([section, mode]),
    _rptEntriesFullyClosed: false,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('onRptEntriesFilterCheckboxChange'), context);

  boxes['rpt-entries-chk-cash'].checked = true;
  context.onRptEntriesFilterCheckboxChange();
  assert.deepStrictEqual(calls.pop(), ['entries', 'cash'], 'Cash checked alone -> cash mode, via the existing setRptPayMode pipeline');

  boxes['rpt-entries-chk-cash'].checked = false;
  boxes['rpt-entries-chk-online'].checked = true;
  context.onRptEntriesFilterCheckboxChange();
  assert.deepStrictEqual(calls.pop(), ['entries', 'online'], 'Online checked alone -> online mode');

  boxes['rpt-entries-chk-cash'].checked = true; // both checked -> no payment-type restriction
  context.onRptEntriesFilterCheckboxChange();
  assert.deepStrictEqual(calls.pop(), ['entries', 'all'], 'both Cash and Online checked -> all (equivalent to no restriction)');

  boxes['rpt-entries-chk-cash'].checked = false;
  boxes['rpt-entries-chk-online'].checked = false; // neither checked -> no payment-type restriction
  context.onRptEntriesFilterCheckboxChange();
  assert.deepStrictEqual(calls.pop(), ['entries', 'all'], 'neither checked -> all (no restriction)');

  boxes['rpt-entries-chk-closed'].checked = true;
  context.onRptEntriesFilterCheckboxChange();
  assert.strictEqual(context._rptEntriesFullyClosed, true, 'Fully Closed checkbox state is captured independently of Cash/Online');
}

// ── 3. Combined filtering + totals: reuses _applyPayMode and
//    _entryMarksPermanentClosure exactly as filterRptEntries wires them,
//    proving the AND-combination and that totals only ever reflect the
//    filtered entries (filtered list total === displayed total, since
//    _calcEntriesTotals is fed the exact same array). ─────────────────────
{
  const context = { Object, Array, String, Number, Boolean, _RPT_ONLINE_KW: ['gpay', 'googlepay', 'phonepe', 'paytm', 'online', 'upi', 'neft', 'bank transfer', 'imps', 'bank'] };
  vm.createContext(context);
  ['_isOnlinePayEntry', '_applyPayMode', '_entryMarksPermanentClosure', '_calcEntriesTotals']
    .forEach(name => vm.runInContext(extractFunction(name), context));

  const entries = [
    { id: 'e1', name: 'Ravi', today: 500, pay: 'Cash', isFullPaid: true },              // cash, fully closed
    { id: 'e2', name: 'Suresh', today: 300, pay: 'GPay', isFullPaid: false },           // online, not closed
    { id: 'e3', name: 'Geeta', today: 400, pay: 'Cash', isFullPaid: false },            // cash, not closed
    { id: 'e4', name: 'Kumar', today: 200, pay: 'UPI', paymentPurpose: 'loan_closure' }, // online, fully closed
  ];

  function apply(mode, closed) {
    const afterMode = context._applyPayMode(entries, mode, true);
    const afterClosed = closed ? afterMode.filter(context._entryMarksPermanentClosure) : afterMode;
    return { list: afterClosed, totals: context._calcEntriesTotals(afterClosed) };
  }

  // Cash only
  let r = apply('cash', false);
  assert.deepStrictEqual(r.list.map(e => e.id), ['e1', 'e3'], 'Cash-only filter selects only cash entries');
  assert.strictEqual(r.totals.total, 900, 'Cash-only total matches the sum of only the filtered entries (500+400)');
  assert.strictEqual(r.totals.count, 2);

  // Fully Closed only
  r = apply('all', true);
  assert.deepStrictEqual(r.list.map(e => e.id), ['e1', 'e4'], 'Fully-Closed-only filter selects only closure entries');
  assert.strictEqual(r.totals.total, 700, 'Fully-Closed-only total is 500+200');

  // Combined: Cash AND Fully Closed
  r = apply('cash', true);
  assert.deepStrictEqual(r.list.map(e => e.id), ['e1'], 'Cash + Fully Closed combined narrows to only entries matching BOTH');
  assert.strictEqual(r.totals.total, 500, 'combined total matches only the doubly-filtered entry');

  // Combined: Online AND Fully Closed
  r = apply('online', true);
  assert.deepStrictEqual(r.list.map(e => e.id), ['e4'], 'Online + Fully Closed combined narrows correctly');

  // No restriction: all 4 entries, no duplicate counting
  r = apply('all', false);
  assert.strictEqual(r.list.length, 4);
  assert.strictEqual(r.totals.total, 1400, 'unfiltered total is the exact sum with no duplicate counting (500+300+400+200)');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'checkboxes-present-on-entries-card-only',
    'loan-issues-buttons-untouched',
    'checkbox-mode-resolution-reuses-setRptPayMode',
    'fully-closed-state-captured-independently',
    'cash-only-filter-and-total',
    'fully-closed-only-filter-and-total',
    'combined-cash-and-closed',
    'combined-online-and-closed',
    'unfiltered-total-no-duplicate-counting',
  ],
}, null, 2));
