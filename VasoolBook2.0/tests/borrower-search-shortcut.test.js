'use strict';

// Verifies the new persistent Borrower Search shortcut (summary-row icon +
// cross-tab jump-to-card), added without touching existing borrower
// calculations/workflow logic.

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

// ── 1. HTML structure: icon lives inside the sticky summary row, dropdown
//    exists, and the pre-existing live-filter wiring is untouched. ────────
{
  const totalsBarStart = source.indexOf('id="borrower-totals-bar"');
  const totalsBarEnd = source.indexOf('</div>', source.indexOf('</div>', totalsBarStart) + 1);
  const totalsBarHtml = source.slice(Math.max(0, totalsBarStart - 200), totalsBarEnd);
  assert.ok(totalsBarHtml.includes('focusBorrowerSearch()'), 'search shortcut icon lives inside the summary/totals row');
  assert.ok(totalsBarHtml.includes('id="btb-count"') && totalsBarHtml.includes('id="btb-amount"'), 'existing count/amount spans are preserved');

  const subtabBarStart = source.indexOf('id="borrower-subtab-bar"');
  assert.ok(source.slice(subtabBarStart, subtabBarStart + 200).includes('position:sticky'), 'the summary row\'s container is still sticky, so the icon stays accessible while scrolling');

  const searchInputTag = source.slice(source.indexOf('id="borrower-search"') - 60, source.indexOf('id="borrower-search"') + 400);
  assert.ok(searchInputTag.includes('scheduleBorrowerRender()'), 'the existing in-place live filter (scheduleBorrowerRender) is still wired and unchanged');
  assert.ok(searchInputTag.includes('scheduleBorrowerSearchDropdownIfOpen()'), 'typing only updates the cross-tab dropdown while it is already open — it is never force-opened by typing alone (overlay-blocks-taps fix)');
  assert.ok(searchInputTag.includes('onfocus="filterBorrowerSearchDropdown()"'), 'focusing the box (e.g. via the shortcut icon) still opens the dropdown explicitly');
  assert.ok(source.includes('id="borrower-search-dropdown"'), 'the search-results dropdown container exists');
}

// ── 2. Search matching covers name, partial name, phone, customer no., and
//    loan no. — real behavioral test of the matching logic. ──────────────
{
  const dom = { display: null, html: null };
  const fakeDropdown = {
    get style() { return { set display(v) { dom.display = v; }, get display() { return dom.display; } }; },
    set innerHTML(v) { dom.html = v; },
    get innerHTML() { return dom.html; },
  };
  const fakeInput = { value: '' };
  const context = {
    Object, Array, String, Number, Boolean,
    $id: id => (id === 'borrower-search-dropdown' ? fakeDropdown : id === 'borrower-search' ? fakeInput : null),
    customers: [{ id: 'c1', name: 'Kamala Devi', phone: '9998887771' }],
    borrowers: [
      { id: 'b1', name: 'Ravi Kumar', area: 'Nehru Nagar', phone: '9876543210', loanno: 'L-101', customerId: null },
      { id: 'b2', name: 'Kamala', area: 'M G Colony', phone: '9998887771', loanno: 'L-202', customerId: 'c1' },
      { id: 'b3', name: 'Suresh Babu', area: 'Anna Nagar', phone: '9111122223', loanno: 'L-303', customerId: null },
    ],
    fmt: n => '₹' + n,
    canonicalBalance: b => 1000,
    // No Area filter selected in these fixtures — every borrower is in scope,
    // same as this test's original "search everyone" intent. Area-scoping
    // itself is covered separately in borrower-search-area-scope-and-overlay-fix.test.js.
    activeArea: 'All', activeSubArea: 'All',
    _areaMatchesValue: () => true, _areaIsUnderMain: () => true,
  };
  vm.createContext(context);
  ['_globalBorrowerSearchNormalize', '_borrowerMatchesActiveArea', 'filterBorrowerSearchDropdown'].forEach(name => vm.runInContext(extractFunction(name), context));

  // partial name
  fakeInput.value = 'kama';
  context.filterBorrowerSearchDropdown();
  assert.ok(dom.html.includes('Kamala'), 'partial name match works');
  assert.ok(!dom.html.includes('Ravi Kumar'), 'non-matching borrowers excluded');

  // phone
  fakeInput.value = '9876543210';
  context.filterBorrowerSearchDropdown();
  assert.ok(dom.html.includes('Ravi Kumar'), 'phone number match works');

  // loan no
  fakeInput.value = 'l-303';
  context.filterBorrowerSearchDropdown();
  assert.ok(dom.html.includes('Suresh Babu'), 'loan no. match works (case-insensitive)');

  // customer's own phone (linked via customerId), not the borrower's own phone field
  fakeInput.value = '9998887771';
  context.filterBorrowerSearchDropdown();
  assert.ok(dom.html.includes('Kamala'), 'linked customer record phone also matches');

  // empty query hides the dropdown instead of showing everything
  fakeInput.value = '';
  context.filterBorrowerSearchDropdown();
  assert.strictEqual(dom.display, 'none', 'empty search hides the dropdown rather than listing all borrowers');

  // no match
  fakeInput.value = 'zzzznotfound';
  context.filterBorrowerSearchDropdown();
  assert.ok(dom.html.includes('No results'), 'a query with no matches shows an explicit empty state');
}

// ── 3. jumpToBorrowerCard / _borrowerTabContainingId: source-level safety
//    checks (renderBorrowers() has too large a dependency graph — interest
//    math, area logic, cycle state — to fully re-exercise in a unit test;
//    these assert the exact contract instead: reuses existing tab-placement
//    logic via renderBorrowers()/setBorrowerTab(), never duplicates it, never
//    touches financial calculation, and clears filters that would hide the
//    target so the card is guaranteed visible). ───────────────────────────
{
  const jumpFn = extractFunction('jumpToBorrowerCard');
  const probeFn = extractFunction('_borrowerTabContainingId');

  assert.ok(probeFn.includes('renderBorrowers()'), 'tab-membership probing reuses the real renderBorrowers() render/filter logic, not a duplicate calculation');
  assert.ok(!/getInterestBreakdown|getInterestCycleCalculation|_periodInterestGross|principalAmt\s*[-+]|loan\s*-\s*prev/.test(jumpFn + probeFn), 'never touches interest/principal/balance calculation logic — display/navigation only');
  assert.ok(jumpFn.includes("$id('borrower-search').value=''") || /searchEl\.value\s*=\s*''/.test(jumpFn), 'clears the search text so the target tab renders unfiltered');
  assert.ok(/dayFilterEl\.value\s*=\s*'All'/.test(jumpFn), 'resets the Day filter so it cannot hide the target card');
  assert.ok(!/setAreaFilter\('All'/.test(jumpFn), 'no longer resets the Area filter — search results are already scoped to the current Area, so the match is guaranteed visible under it');
  assert.ok(/setBorrowerTab\(target\)/.test(jumpFn), 'switches tab via the existing, unmodified setBorrowerTab() when the borrower is in a different tab');
  assert.ok(/data-bid="\+bid\+"|data-bid="'\+bid\+'"/.test(jumpFn), 'targets the existing data-bid card attribute — no new card-identification scheme introduced');
  assert.ok(/scrollIntoView/.test(jumpFn), 'scrolls the resolved card into view');
}

// ── 4. focusBorrowerSearch: instant access regardless of scroll position —
//    scrolls the input into view and focuses it; does not reset any data.
{
  const focusFn = extractFunction('focusBorrowerSearch');
  assert.ok(/scrollIntoView/.test(focusFn), 'scrolls the search input into view');
  assert.ok(/\.focus\(\)/.test(focusFn), 'focuses the search input');
  assert.ok(!/borrowers\s*=|entryLog\s*=|customers\s*=/.test(focusFn), 'never mutates borrower/entry/customer data');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'shortcut-icon-in-sticky-summary-row',
    'existing-live-filter-wiring-unchanged',
    'search-matches-partial-name-phone-customer-loanno',
    'empty-and-no-match-states-handled',
    'tab-probe-reuses-renderBorrowers-no-duplicated-calculation',
    'jump-never-touches-financial-calculations',
    'jump-clears-search-and-day-filters-that-would-hide-target',
    'jump-no-longer-resets-area-filter',
    'jump-uses-existing-setBorrowerTab-and-data-bid',
    'focus-shortcut-scrolls-and-focuses-without-mutating-data',
  ],
}, null, 2));
