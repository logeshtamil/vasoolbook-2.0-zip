'use strict';

// Regression test for the "Borrowers page search/filter freeze" bug.
//
// Root cause: jumpToBorrowerCard() (added for the Borrower Search shortcut)
// used _borrowerTabContainingId(), which probed EVERY subtab by calling the
// full, heavy renderBorrowers() up to 4 times back-to-back on one synchronous
// call stack (3 probe renders + 1 restore render) — renderBorrowers() rebuilds
// the entire card list HTML and recomputes every interest-loan cycle
// calculation, so 4 in a row could block the main thread for a noticeable,
// unresponsive stretch with zero user feedback — exactly a "freeze". There
// was also no re-entrancy guard, so a fast double-tap on a search result
// could kick off two overlapping probes at once.
//
// Fix: check the current tab first (a render there is already required since
// filters were just cleared) — the common case now costs exactly ONE render,
// not four. Only if not found does it try other tabs, and it yields to the
// event loop via setTimeout(...,0) between each further attempt instead of a
// tight synchronous loop, so the browser stays responsive throughout. A
// _jumpToBorrowerBusy guard, released in `finally`, prevents overlapping calls.

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

// ── Fake DOM: only what these functions actually touch ─────────────────────
function makeFakeCard() { return { style: {}, scrollIntoView() {} }; }

function freshContext() {
  const elements = {
    'borrower-search-dropdown': { style: {} },
    'borrower-search': { value: '' },
    'day-filter': { value: 'All' },
    'loan-type-filter': { value: '' },
  };
  const state = {
    renderCount: 0,
    tabMembership: { active: ['b1'], schedule: ['b2'], closed: ['b3'] },
    renderedCards: {},
    toasts: [],
  };
  const context = {
    Object, String, Array, JSON, console, setTimeout, clearTimeout,
    window: {},
    borrowers: [{ id: 'b1', name: 'Active One' }, { id: 'b2', name: 'Schedule One' }, { id: 'b3', name: 'Closed One' }],
    customers: [],
    borrowerTab: 'active',
    activeArea: 'All',
    $id: id => elements[id],
    document: {
      querySelector(sel) {
        const m = /data-bid="([^"]+)"/.exec(sel);
        if (m) return state.renderedCards[m[1]] || null;
        if (sel === '.filter-chip[data-area="All"]') return null;
        return null;
      },
    },
    showToast: msg => state.toasts.push(msg),
    setAreaFilter: () => {},
    renderBorrowers() {
      state.renderCount += 1;
      state.renderedCards = {};
      (state.tabMembership[context.borrowerTab] || []).forEach(bid => { state.renderedCards[bid] = makeFakeCard(); });
    },
    setBorrowerTab(tab) { context.borrowerTab = tab; context.renderBorrowers(); },
    _jumpToBorrowerBusy: false,
    _state: state,
  };
  vm.createContext(context);
  ['_borrowerTabContainingId', 'jumpToBorrowerCard'].forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── 1. Target already in the CURRENT tab: exactly ONE render, not four.
  {
    const ctx = freshContext();
    ctx.borrowerTab = 'active';
    let resolved = null;
    ctx._borrowerTabContainingId('b1', found => { resolved = found; });
    check('same-tab lookup resolves synchronously', resolved === 'active');
    check('same-tab lookup costs exactly one render (was up to 4)', ctx._state.renderCount === 1, 'renderCount=' + ctx._state.renderCount);
  }

  // ── 2. Target in a DIFFERENT tab: found without blocking the call stack —
  //      the callback must NOT fire synchronously (proves setTimeout yielding
  //      is actually used, not a tight synchronous loop).
  {
    const ctx = freshContext();
    ctx.borrowerTab = 'active';
    let resolved = 'not-yet';
    ctx._borrowerTabContainingId('b3', found => { resolved = found; });
    check('cross-tab lookup does not resolve synchronously (yields to the event loop)', resolved === 'not-yet', 'resolved=' + resolved);
    await wait(50);
    check('cross-tab lookup eventually finds the correct tab', resolved === 'closed', 'resolved=' + resolved);
    check('cross-tab lookup used more than one render but stayed bounded (<=3)', ctx._state.renderCount >= 2 && ctx._state.renderCount <= 3, 'renderCount=' + ctx._state.renderCount);
  }

  // ── 3. Target not found in any tab: restores the original tab and resolves null.
  {
    const ctx = freshContext();
    ctx.borrowerTab = 'schedule';
    let resolved = 'not-yet';
    ctx._borrowerTabContainingId('missing', found => { resolved = found; });
    await wait(50);
    check('not-found lookup resolves null', resolved === null);
    check('not-found lookup restores the original tab', ctx.borrowerTab === 'schedule', 'borrowerTab=' + ctx.borrowerTab);
  }

  // ── 4. jumpToBorrowerCard: dropdown is hidden IMMEDIATELY, synchronously,
  //      regardless of outcome (freeze audit: overlay must close right away).
  {
    const ctx = freshContext();
    ctx._state.elDropdownDisplay = 'flex';
    ctx.$id('borrower-search-dropdown').style.display = '';
    ctx.jumpToBorrowerCard('b1');
    check('search dropdown is hidden synchronously on selection', ctx.$id('borrower-search-dropdown').style.display === 'none');
  }

  // ── 5. Re-entrancy guard: a fast double-tap must not start a second
  //      overlapping probe (each probe would otherwise double the render cost).
  {
    const ctx = freshContext();
    ctx.borrowerTab = 'active';
    ctx.jumpToBorrowerCard('b3'); // first tap — starts an async cross-tab probe
    const countAfterFirstTap = ctx._state.renderCount;
    check('first tap performs exactly its one synchronous current-tab render before yielding', countAfterFirstTap === 1, 'renderCount=' + countAfterFirstTap);
    ctx.jumpToBorrowerCard('b3'); // immediate second tap — must be ignored while busy
    check('immediate duplicate tap does not add any render (guard blocks it before it starts)', ctx._state.renderCount === countAfterFirstTap, 'renderCount=' + ctx._state.renderCount);
    await wait(50);
    // A full successful cross-tab jump costs 3 probe renders (active, schedule,
    // closed-found) + 1 setBorrowerTab render to switch and update the subtab
    // UI = 4. If the duplicate tap had NOT been blocked, a second overlapping
    // probe would inflate this further (8, or an inconsistent count from two
    // interleaved probes racing each other) — 4 proves only one probe ran.
    check('duplicate tap while busy never starts a second overlapping probe (total stays at one jump cost)', ctx._state.renderCount === 4, 'renderCount=' + ctx._state.renderCount);
  }

  // ── 6. The busy guard is always released, even when the lookup finds
  //      nothing — a `finally`-style release, not just on the happy path.
  {
    const ctx = freshContext();
    ctx.jumpToBorrowerCard('does-not-exist-anywhere');
    await wait(50);
    let secondRan = false;
    const realBorrowerTabContainingId = ctx._borrowerTabContainingId;
    ctx._borrowerTabContainingId = function (bid, cb) { secondRan = true; return realBorrowerTabContainingId(bid, cb); };
    ctx.jumpToBorrowerCard('b1');
    check('busy guard is released after a not-found lookup, not stuck forever', secondRan === true);
  }

  // ── 7. Source-level: filterBorrowerSearchDropdown is debounced (schedule
  //      wrapper), not fired synchronously on every keystroke — the other
  //      half of the freeze/lag fix (typing lag on the full-borrower scan).
  {
    assert.ok(source.includes('function scheduleBorrowerSearchDropdownIfOpen()'), 'a debounced scheduler exists for the search dropdown');
    assert.match(source, /oninput="scheduleBorrowerRender\(\);scheduleBorrowerSearchDropdownIfOpen\(\)"/, 'the search input calls the debounced "if already open" scheduler on every keystroke, not the synchronous full-scan directly and never force-opening the dropdown');
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
    failures: failed,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
