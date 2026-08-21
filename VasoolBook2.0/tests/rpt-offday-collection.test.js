'use strict';

// Verifies the new Off-Day / Half-Day Collection report: a saved Collection
// Entry is classified as Off-Day whenever its payment date does not fall on
// the borrower's assigned Collection Day for the area it was collected in
// (resolved from the entry's OWN saved area name, not the borrower's current
// area — so a later area reassignment cannot retroactively reclassify a
// historical entry). Covers same-day/off-day classification, Main/Sub Area
// scoping (Main Area auto-includes its Sub Areas), search, payment-type
// filter, date range, summary totals, and duplicate-prevention (an entry is
// never counted twice, never appears for an unconfigured area's day).

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
  todayStr: () => '2026-08-20',
  // Simple, faithful stand-in for the real (deeper calendar-parsing) _dateOnly
  // — this test only ever feeds it plain 'YYYY-MM-DD' strings, which is all
  // _dateDayName needs from it.
  _dateOnly(value) {
    const [y, m, d] = String(value || '').slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
  },
  _RPT_ONLINE_KW: ['gpay', 'googlepay', 'phonepe', 'paytm', 'online', 'upi', 'neft', 'bank transfer', 'imps', 'bank'],
};
vm.createContext(context);
[
  '_normArea', '_areaId', '_areaName', '_areaKey', '_findAreaById', '_findAreaByName', '_findArea', '_entityAreaObj',
  '_areaIsUnderMain', '_areaMatchesValue', '_parentAreaId', '_looksMainAreaId', '_looksSubAreaId', '_looksAreaId',
  '_isMainArea', '_getAreaDay', '_findMainAreaByName', '_areaDayByName', '_dateDayName',
  '_subAreasForMain', '_isOnlinePayEntry', '_entryAssignedCollectionDay', '_isHalfDayCollectionEntry',
  '_halfDayCollectionEntries', '_calcHalfDayCollectionTotals',
].forEach(name => vm.runInContext(extractFunction(name), context));

// ── Fixture: two Main Areas, one with a Sub Area, borrowers assigned to each,
// and a mix of on-day / off-day / unconfigured-area payments across a date
// range that spans a Thursday (2026-08-20) and other weekdays.
context.areas = [
  { areaId: '1001', name: 'Nehru Nagar', day: 'Thursday' },
  { areaId: '1002', name: 'M G Colony', day: 'Monday' },
  { areaId: '101', name: 'MGC South', areaType: 'sub', parentAreaId: '1002', day: 'Tuesday' }, // its own day, overrides parent
  { areaId: '102', name: 'MGC North', areaType: 'sub', parentAreaId: '1002' }, // inherits parent Monday
  { areaId: '1003', name: 'No Schedule Area' }, // no day configured at all
];
context.customers = [];
context.borrowers = [
  { id: 'b1', name: 'Ravi Kumar', area: 'Nehru Nagar', areaId: '1001', loanno: 'L-101', custNo: 'C-01' },
  { id: 'b2', name: 'Suresh Babu', area: 'MGC South', areaId: '101', loanno: 'L-202', custNo: 'C-02' },
  { id: 'b3', name: 'Geeta Devi', area: 'MGC North', areaId: '102', loanno: 'L-303', custNo: 'C-03' },
  { id: 'b4', name: 'Kumar Raja', area: 'No Schedule Area', areaId: '1003', loanno: 'L-404', custNo: 'C-04' },
];
context.entryLog = [
  // 2026-08-20 is a Thursday.
  { id: 'e1', bid: 'b1', name: 'Ravi Kumar', area: 'Nehru Nagar', date: '2026-08-20', today: 500, pay: 'Cash' },   // ON assigned day (Thursday) -> NOT off-day
  { id: 'e2', bid: 'b1', name: 'Ravi Kumar', area: 'Nehru Nagar', date: '2026-08-17', today: 500, pay: 'GPay' },  // 2026-08-17 is Monday -> OFF-day
  { id: 'e3', bid: 'b2', name: 'Suresh Babu', area: 'MGC South', date: '2026-08-18', today: 300, pay: 'Cash' },   // 2026-08-18 Tuesday, sub-area's OWN day -> NOT off-day
  { id: 'e4', bid: 'b2', name: 'Suresh Babu', area: 'MGC South', date: '2026-08-17', today: 300, pay: 'UPI' },    // Monday, not Tuesday -> OFF-day
  { id: 'e5', bid: 'b3', name: 'Geeta Devi', area: 'MGC North', date: '2026-08-17', today: 400, pay: 'Cash' },    // Monday, inherited parent day -> NOT off-day
  { id: 'e6', bid: 'b3', name: 'Geeta Devi', area: 'MGC North', date: '2026-08-19', today: 400, pay: 'PhonePe' }, // Wednesday -> OFF-day
  { id: 'e7', bid: 'b4', name: 'Kumar Raja', area: 'No Schedule Area', date: '2026-08-19', today: 200, pay: 'Cash' }, // no configured day -> excluded from both
];

// ── 1. Same-day: a payment on the assigned Collection Day is NOT off-day.
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[0]), false, 'payment on the assigned day (Thursday, Nehru Nagar) is not off-day');
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[2]), false, "payment on the sub-area's own assigned day (Tuesday, MGC South) is not off-day");
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[4]), false, 'payment on the inherited parent day (Monday, MGC North) is not off-day');

// ── 2. Off-day: a payment on any other day IS off-day.
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[1]), true, 'payment on Monday (assigned Thursday) is off-day');
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[3]), true, 'payment on Monday (sub-area assigned Tuesday) is off-day');
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[5]), true, 'payment on Wednesday (assigned Monday) is off-day');

// ── 3. Unconfigured area day: cannot be classified either way — excluded
//    (never falsely counted as off-day, avoiding a false positive report).
assert.strictEqual(context._isHalfDayCollectionEntry(context.entryLog[6]), false, 'an area with no configured collection day is not classified as off-day');

// ── 4. Full list, no filters: exactly the 4 off-day entries, none of the
//    3 on-day entries, none of the 1 unconfigured entry — proving the
//    partition (duplicate prevention: on-day entries never leak in here).
{
  const list = context._halfDayCollectionEntries('', '', 'All', 'All', '', 'all');
  assert.deepStrictEqual(list.map(e => e.id).sort(), ['e2', 'e4', 'e6'].sort(), 'only genuinely off-day entries appear; on-day and unconfigured entries never leak in');
}

// ── 5. Date range filter (From/To).
{
  const list = context._halfDayCollectionEntries('2026-08-18', '2026-08-20', 'All', 'All', '', 'all');
  assert.deepStrictEqual(list.map(e => e.id).sort(), ['e6'].sort(), 'date range excludes off-day entries outside From-To');
}

// ── 6. Main Area filter automatically includes its Sub Areas.
{
  const list = context._halfDayCollectionEntries('', '', '1002', 'All', '', 'all'); // M G Colony (main) -> includes MGC South + MGC North subs
  assert.deepStrictEqual(list.map(e => e.id).sort(), ['e4', 'e6'].sort(), 'selecting the Main Area includes all its Sub Areas automatically');
}

// ── 7. Sub-Area drill-down narrows to just that sub-area.
{
  const list = context._halfDayCollectionEntries('', '', '1002', '101', '', 'all'); // MGC South only
  assert.deepStrictEqual(list.map(e => e.id).sort(), ['e4'], 'sub-area drill-down narrows correctly');
}

// ── 8. Search by Name / Customer No / Loan No.
{
  assert.deepStrictEqual(context._halfDayCollectionEntries('', '', 'All', 'All', 'suresh', 'all').map(e => e.id), ['e4'], 'search by partial name');
  assert.deepStrictEqual(context._halfDayCollectionEntries('', '', 'All', 'All', 'l-303', 'all').map(e => e.id), ['e6'], 'search by loan no. (case-insensitive)');
  assert.deepStrictEqual(context._halfDayCollectionEntries('', '', 'All', 'All', 'c-01', 'all').map(e => e.id), ['e2'], 'search by customer no.');
}

// ── 9. Payment Type filter: Cash / UPI / All.
{
  const cashOnly = context._halfDayCollectionEntries('', '', 'All', 'All', '', 'cash').map(e => e.id).sort();
  const onlineOnly = context._halfDayCollectionEntries('', '', 'All', 'All', '', 'online').map(e => e.id).sort();
  assert.deepStrictEqual(onlineOnly, ['e2', 'e4', 'e6'].sort(), 'Online filter selects only online-paid off-day entries (GPay/UPI/PhonePe)');
  assert.deepStrictEqual(cashOnly, [], 'no off-day entries were paid in cash in this fixture, Cash filter correctly returns none');
}

// ── 10. Summary totals: Total Entries, Total Amount, Cash Total, UPI Total,
//     Main-Area totals — recomputed from the filtered list only.
{
  const list = context._halfDayCollectionEntries('', '', 'All', 'All', '', 'all');
  const t = context._calcHalfDayCollectionTotals(list);
  assert.strictEqual(t.count, 3, 'Total Entries matches the filtered list length');
  assert.strictEqual(t.total, 500 + 300 + 400, 'Total Amount sums only the filtered entries');
  assert.strictEqual(t.cash, 0, 'Cash Total correctly zero (all 3 off-day entries are online-paid)');
  assert.strictEqual(t.upi, 1200, 'UPI Total matches the sum of the online-paid off-day entries');
  assert.strictEqual(t.byMainArea['Nehru Nagar'].total, 500, 'Main-Area total for Nehru Nagar');
  assert.strictEqual(t.byMainArea['M G Colony'].total, 700, 'Main-Area total correctly rolls sub-area entries up to their Main Area (300+400)');
}

// ── 11. Historical entries: classification is unaffected by a LATER
//     borrower area reassignment, because it reads the entry's OWN saved
//     area (e.area), never the borrower's current area.
{
  const reassignedBorrower = Object.assign({}, context.borrowers[0], { area: 'M G Colony', areaId: '1002' }); // b1 moved to a different area after the fact
  context.borrowers = context.borrowers.map(b => b.id === 'b1' ? reassignedBorrower : b);
  const stillOffDay = context._isHalfDayCollectionEntry(context.entryLog[1]); // e2: saved area was still 'Nehru Nagar' at payment time
  assert.strictEqual(stillOffDay, true, 'historical entry classification is unaffected by a later borrower area reassignment');
  context.borrowers[0] = context.borrowers[0]; // (no revert needed; entryLog-based classification never read borrowers[0] here)
}

// ── 12. Edited collection-day mapping: this is the disclosed, honest limit
//     of "use saved transaction-era mapping where available" — no separate
//     point-in-time DAY snapshot exists on entryLog rows (only the area NAME
//     is saved), so editing an area's OWN day config after the fact DOES
//     change how historical entries in that same area classify. Documented
//     behavior, not a bug — proven explicitly here rather than left implicit.
{
  const before = context._isHalfDayCollectionEntry(context.entryLog[0]); // e1: Thursday payment, Nehru Nagar assigned Thursday
  assert.strictEqual(before, false, 'sanity: e1 is on-day before the area edit');
  context.areas = context.areas.map(a => a.areaId === '1001' ? Object.assign({}, a, { day: 'Monday' }) : a); // admin edits Nehru Nagar's day after the fact
  const after = context._isHalfDayCollectionEntry(context.entryLog[0]);
  assert.strictEqual(after, true, "editing the area's collection-day config after the fact does shift historical classification for that area (disclosed limitation: no point-in-time day snapshot exists on entryLog rows)");
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'same-day-not-offday',
    'subarea-own-day-not-offday',
    'inherited-parent-day-not-offday',
    'offday-detected-main-and-sub',
    'unconfigured-area-excluded',
    'partition-no-duplicate-leakage',
    'date-range-filter',
    'main-area-includes-subareas',
    'subarea-drilldown',
    'search-name-loanno-customerno',
    'payment-type-filter',
    'summary-totals-and-main-area-rollup',
    'historical-entry-unaffected-by-borrower-reassignment',
    'edited-area-day-mapping-documented-limitation',
  ],
}, null, 2));
