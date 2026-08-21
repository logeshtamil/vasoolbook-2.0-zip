'use strict';

// Verifies the second round of Borrower Search shortcut fixes:
//   1. The search icon sits at the true horizontal center of the summary
//      bar (grid 1fr auto 1fr, icon in the center column) instead of grouped
//      with the count on the left.
//   2. Search scope is limited to the currently selected Area (name,
//      partial name, phone, Customer No., Loan No. — NOT area name itself,
//      since Area is now the filter, not a search field).
//   3. Root cause of "card buttons stop working after searching": the
//      results dropdown used to auto-open on every keystroke and could
//      overlap the top of the card list, silently swallowing the first tap
//      meant for a card action button. Fix: the dropdown now only updates
//      while it is ALREADY open (explicitly summoned via the icon or a
//      focus-with-text event) — plain typing only ever runs the existing
//      in-place list filter, with no floating overlay at all.
//   4. Selecting a result no longer needs to reset the Area filter (the
//      match is already guaranteed to be within it).

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

// ── 1. Icon is centered via a 3-column grid, not flex-grouped with the count.
{
  const barStart = source.indexOf('id="borrower-totals-bar"');
  assert.ok(barStart >= 0, 'borrower-totals-bar exists');
  const barHtml = source.slice(barStart, barStart + 900);
  assert.match(barHtml, /grid-template-columns:1fr auto 1fr/, 'totals bar uses a 3-column grid so the middle column is the true center regardless of count/amount text width');
  assert.match(barHtml, /focusBorrowerSearch\(\)[^]*?justify-self:center/, 'the search icon sits in the centered grid column');
  const iconPos = barHtml.indexOf('focusBorrowerSearch()');
  const countPos = barHtml.indexOf('id="btb-count"');
  const amountPos = barHtml.indexOf('id="btb-amount"');
  assert.ok(countPos < iconPos && iconPos < amountPos, 'DOM order is count, icon, amount — icon is the middle grid cell');
}

// ── 2. Dropdown only auto-updates while already open; oninput never
//      force-opens it — the actual overlay-blocks-taps fix.
assert.match(source, /oninput="scheduleBorrowerRender\(\);scheduleBorrowerSearchDropdownIfOpen\(\)"/, 'typing calls the "if already open" scheduler, never an unconditional opener');
{
  const fnSource = extractFunction('scheduleBorrowerSearchDropdownIfOpen');
  assert.match(fnSource, /dd\.style\.display==='none'\|\|!dd\.style\.display\)return/, 'the scheduler is a no-op while the dropdown is closed — typing alone can never open it');
}

// ── 3. Area-scoped search: _borrowerMatchesActiveArea gates every candidate,
//      and the searchable text no longer includes the area name (since Area
//      is now the filter/scope, not a search field).
{
  const fnSource = extractFunction('filterBorrowerSearchDropdown');
  assert.match(fnSource, /if\(!_borrowerMatchesActiveArea\(b\)\)return false;/, 'every candidate is gated by the current Area filter before any text match runs');
  assert.doesNotMatch(fnSource, /b\.area,/, 'area name itself is no longer part of the searchable text (name/phone/customer no./loan no. only)');
  ['b.name', 'b.phone', 'b.loanno', 'b.customerId', 'c.name', 'c.phone'].forEach(field => {
    assert.ok(fnSource.includes(field), `search text still includes ${field}`);
  });
}

// ── 4. Behavioral: _borrowerMatchesActiveArea actually scopes correctly.
{
  const context = {
    Boolean, String,
    activeArea: 'North Zone', activeSubArea: 'All',
    _areaMatchesValue: (b, value) => b.area === value,
    _areaIsUnderMain: () => false,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('_borrowerMatchesActiveArea'), context);
  assert.strictEqual(context._borrowerMatchesActiveArea({ area: 'North Zone' }), true, 'a borrower in the selected area matches');
  assert.strictEqual(context._borrowerMatchesActiveArea({ area: 'South Zone' }), false, 'a borrower in a different area is excluded from search scope');

  context.activeArea = 'All';
  assert.strictEqual(context._borrowerMatchesActiveArea({ area: 'Anywhere' }), true, 'with no area filter (All), every borrower is in scope, same as before');

  context.activeArea = 'North Zone';
  context.activeSubArea = 'North Zone - East';
  context._areaMatchesValue = (b, value) => b.area === value;
  context._areaIsUnderMain = (b, mainValue) => mainValue === 'North Zone' && String(b.area || '').indexOf('North Zone - ') === 0;
  assert.strictEqual(context._borrowerMatchesActiveArea({ area: 'North Zone - East' }), true, 'a specific sub-area selection further narrows the scope to that sub-area');
  assert.strictEqual(context._borrowerMatchesActiveArea({ area: 'North Zone - West' }), false, 'a borrower in a sibling sub-area is excluded once a specific sub-area is selected');
}

// ── 5. jumpToBorrowerCard no longer resets the Area filter to All (the
//      match is already guaranteed to be within the current area).
{
  const fnSource = extractFunction('jumpToBorrowerCard');
  assert.doesNotMatch(fnSource, /setAreaFilter\('All'/, 'selecting a result no longer forces the Area filter back to All');
  assert.match(fnSource, /dd\.style\.display='none'/, 'the dropdown still closes immediately on selection (unchanged)');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'search-icon-true-center-grid',
    'dropdown-never-force-opens-on-typing',
    'dropdown-updates-only-while-already-open',
    'search-scoped-to-active-area',
    'area-name-no-longer-a-search-field',
    'search-fields-name-phone-customerno-loanno-present',
    'area-scope-behavioral-match',
    'area-scope-behavioral-exclude',
    'area-scope-all-includes-everyone',
    'sub-area-narrows-scope-further',
    'jump-no-longer-resets-area-filter',
    'dropdown-still-closes-on-selection',
  ],
}, null, 2));
