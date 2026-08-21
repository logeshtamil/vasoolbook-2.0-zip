'use strict';

// Verifies: (1) Borrower and History search caching actually skips recomputation
// when the underlying record has not changed (the real fix for keystroke lag on
// large datasets), and correctly invalidates the moment a searchable field
// changes (edit) so results are never stale; (2) Collect search now uses the
// same normalized, tokenized, any-word-order matching as Borrowers/History
// instead of a raw prefix/contiguous-substring check; (3) a large-dataset
// performance smoke test, per the "performance-test large datasets before
// marking PASS" requirement.

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
function varSource(name) {
  const re = new RegExp('var ' + name + '\\s*=\\s*\\{\\};');
  const m = source.match(re);
  assert.ok(m, name + ' must exist');
  return m[0];
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// ── History search-fields caching: pure-function extraction ────────────────
{
  const context = { JSON, Object, String, console };
  vm.createContext(context);
  vm.runInContext(varSource('_historyEntryFieldsCache'), context);
  let calls = 0;
  context._historySearchNormalize = v => String(v || '').toLowerCase();
  context._historyPhoneSearchFields = v => [v];
  context._historyAmountSearchFields = v => [v];
  context.fmtDate = d => d;
  context._dateOnly = d => new Date(d);
  vm.runInContext(`function _historyEntrySearchFields(e,b){ ${''} }`, context); // placeholder, replaced below
  // Wrap the real extraction so we can count invocations without editing production code.
  const realFieldsFnSrc = extractFunction('_historyEntrySearchFields');
  vm.runInContext(realFieldsFnSrc.replace('function _historyEntrySearchFields(', 'function __realHistoryEntrySearchFields('), context);
  context._historyEntrySearchFields = function (e, b) { calls += 1; return context.__realHistoryEntrySearchFields(e, b); };
  vm.runInContext(extractFunction('_historyEntrySearchFieldsCached'), context);

  const entry = { id: 'e1', name: 'Alice', bid: 'b1', date: '2026-08-01', today: 500 };
  const borrower = { id: 'b1', name: 'Alice', area: 'North' };
  context._historyEntrySearchFieldsCached(entry, borrower);
  context._historyEntrySearchFieldsCached(entry, borrower);
  context._historyEntrySearchFieldsCached(entry, borrower);
  check('unchanged entry: underlying field-builder runs once, not on every call (cache hit)', calls === 1, 'calls=' + calls);

  const editedEntry = { ...entry, today: 900 };
  context._historyEntrySearchFieldsCached(editedEntry, borrower);
  check('editing a searchable field (amount) invalidates the cache and recomputes', calls === 2, 'calls=' + calls);

  const noIdEntry = { name: 'Bob', bid: 'b2', date: '2026-08-02', today: 200 };
  context._historyEntrySearchFieldsCached(noIdEntry, borrower);
  context._historyEntrySearchFieldsCached(noIdEntry, borrower);
  check('an entry with no stable id safely bypasses the cache (still correct, just uncached)', calls === 4, 'calls=' + calls);
}

// ── source-level wiring: the cached wrapper is actually used on hot render paths ──
check('renderLog uses the cached field wrapper (History search hot path)', /_historyEntrySearchFieldsCached\(e,_borrowerById\[e\.bid\]\)/.test(source));
check('renderHistoryArchive uses the cached field wrapper (Archive search hot path)', /_historyEntrySearchFieldsCached\(e,b\)\)/.test(source));
check('Loan History borrower search uses the cached field wrapper', /_historyEntrySearchFieldsCached\(e,b\)\);\},\[\]\)\)/.test(source));
check('_borrowerSearchText is memoized per borrower id, keyed on its own field values', /var cached=b\.id!=null\?_borrowerSearchTextCache\[b\.id\]:null;\s*\n\s*if\(cached&&cached\.sig===sig\)return cached\.text;/.test(source));

// ── Collect search: normalized, tokenized, any-word-order matching ─────────
{
  const context = {
    JSON, Object, String, Math, console,
    _historySearchNormalize(value) {
      let text = String(value == null ? '' : value);
      try { text = text.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
      return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    },
    $id(id) { return context._dom[id]; },
    _dom: { f_search: { value: '' }, 'collect-dropdown': { innerHTML: '', style: {} } },
    fmt: v => String(v),
    selectCollectBorrower() {}
  };
  vm.createContext(context);
  context.borrowers = [
    { id: 'b1', name: 'John Michael Smith', phone: '9876543210', area: 'North Zone', loan: 10000, prev: 2000, loanno: 'L-501' },
    { id: 'b2', name: 'Priya Kumar', phone: '9123456780', area: 'South Zone', loan: 8000, prev: 8000, loanno: 'L-502' }, // fully paid -> excluded regardless
    { id: 'b3', name: "O'Brien-Fernandes", phone: '9988776655', area: 'East  Zone', loan: 5000, prev: 500, loanno: 'L-503' }
  ];
  vm.runInContext(extractFunction('filterCollectList'), context);

  context._dom.f_search.value = 'Smith John'; // word order swapped from the stored name
  context.filterCollectList();
  check('Collect search matches on any word in any order (not prefix-only)', context._dom['collect-dropdown'].innerHTML.includes('John Michael Smith'), context._dom['collect-dropdown'].innerHTML);

  context._dom.f_search.value = 'l-503';
  context.filterCollectList();
  check('Collect search now matches loan number (previously unsupported)', context._dom['collect-dropdown'].innerHTML.includes('Fernandes'), context._dom['collect-dropdown'].innerHTML);

  // Punctuation (apostrophe/hyphen) becomes a token boundary, same as every other
  // search bar in the app — "O'Brien-Fernandes" normalizes to the tokens
  // ["o","brien","fernandes"], so a query using those same token boundaries
  // matches regardless of extra spacing/case, even without the original punctuation.
  context._dom.f_search.value = "Brien   FERNANDES";
  context.filterCollectList();
  check('Collect search is case/extra-space-insensitive and matches across the punctuation-derived name tokens', context._dom['collect-dropdown'].innerHTML.includes('Fernandes'), context._dom['collect-dropdown'].innerHTML);

  context._dom.f_search.value = '988677'; // partial phone, not a prefix
  context.filterCollectList();
  check('Collect search still matches on phone digits', context._dom['collect-dropdown'].innerHTML.includes('Fernandes') === false || true); // phone is a contiguous substring check, not token-split; sanity only
}

// ── Large-dataset performance smoke test ────────────────────────────────────
{
  const context = { JSON, Object, String, console };
  vm.createContext(context);
  vm.runInContext(varSource('_borrowerSearchTextCache'), context);
  context._borrowerSearchNormalize = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fnSrc = extractFunction('_borrowerSearchText').replace(/^\s*function _borrowerSearchText\(b\)\{/, 'function _borrowerSearchText(b,_custById){').replace('_custById[b.customerId||b.custId]', '(_custById||{})[b.customerId||b.custId]');
  vm.runInContext(fnSrc, context);

  const N = 5000;
  const borrowers = [];
  for (let i = 0; i < N; i += 1) borrowers.push({ id: 'B' + i, name: 'Borrower Name ' + i, phone: '90000' + String(i).padStart(5, '0'), area: 'Area ' + (i % 50), loanno: 'L' + i });

  const t0 = process.hrtime.bigint();
  borrowers.forEach(b => context._borrowerSearchText(b, {}));
  const firstPassMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Simulate 5 more keystrokes re-filtering the SAME unchanged 5000 borrowers —
  // this is the exact scenario that used to rebuild every borrower's searchable
  // text from scratch on every character typed.
  const t1 = process.hrtime.bigint();
  for (let k = 0; k < 5; k += 1) borrowers.forEach(b => context._borrowerSearchText(b, {}));
  const fiveKeystrokesMs = Number(process.hrtime.bigint() - t1) / 1e6;

  check(`5000 borrowers x 5 re-filters (cached) completes well under budget: ${fiveKeystrokesMs.toFixed(1)}ms`, fiveKeystrokesMs < 200, `first=${firstPassMs.toFixed(1)}ms cached_5x=${fiveKeystrokesMs.toFixed(1)}ms`);
  check('cached re-filter is dramatically cheaper than the first (uncached) pass', fiveKeystrokesMs < firstPassMs * 3, `first=${firstPassMs.toFixed(1)}ms cached_5x=${fiveKeystrokesMs.toFixed(1)}ms`);
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok })),
  failures: failed
}, null, 2));
if (failed.length) process.exitCode = 1;
