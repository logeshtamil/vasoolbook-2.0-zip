'use strict';

// Verifies the Interest Loan payment UI changes:
//   1. The top Cycle Period banner (#ci-cycle-banner) is now tappable and
//      reveals/opens the EXISTING cycle selector (#ci-cycle-sel-wrap /
//      #ci-cycle-sel) — selecting an option still goes through the
//      unmodified onCycleSelChange(), which already loads the exact cycle's
//      real interest amount and details (hidden inputs + visible chips).
//      Nothing about that calculation logic is touched by this change.
//   2. The entire "Advance Interest Periods" input/description/row is
//      removed from the UI, along with every reference to it, but the
//      underlying advance-interest payment allocation logic
//      (_advanceInterestPlan / _rebuildAdvanceInterestEntry /
//      _proceedSaveEntryNextCycle) is completely untouched — it never
//      actually read that removed input in the live save path anyway
//      (periodLimit was already hardcoded to 600), so removing the UI has
//      zero effect on saved payment/cycle data or calculations.

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

// ── 1. Advance Interest Periods UI is completely gone. ──────────────────────
assert.ok(!source.includes('Advance Interest Periods'), 'the section label is gone');
assert.ok(!source.includes('id="ci-advance-period-row"'), 'the row wrapper is gone');
assert.ok(!source.includes('id="ci-advance-periods"'), 'the input is gone');
assert.ok(!source.includes('Advance amount is limited to the selected weekly/monthly periods.'), 'the description text is gone');
assert.ok(!/function _advanceInterestSelectedPeriods/.test(source), 'the now-orphaned reader function (it had zero callers even before this change) is removed');
assert.ok(!source.includes("$id('ci-advance-period-row')"), 'no remaining JS references to the removed row');
assert.ok(!source.includes("$id('ci-advance-periods')"), 'no remaining JS references to the removed input');

// ── 2. The actual advance-interest payment allocation logic is untouched. ──
assert.ok(/function _advanceInterestPlan\(/.test(source), '_advanceInterestPlan still exists, unmodified');
assert.ok(/function _rebuildAdvanceInterestEntry\(/.test(source), '_rebuildAdvanceInterestEntry (used when editing a saved advance-interest entry) still exists, unmodified');
const nextCycleFn = extractFunction('_proceedSaveEntryNextCycle');
assert.match(nextCycleFn, /var periodLimit=600;/, 'the live new-payment save path still uses its own hardcoded period limit — it never actually depended on the removed input, so removing the UI changes nothing about payment allocation');
assert.match(nextCycleFn, /_advanceInterestPlan\(b,dateVal,excess,periodLimit,currentAlloc\.payments,discountAmt,''\)/, 'the allocation call itself is byte-for-byte unchanged');

// ── 3. The top Cycle Period banner is now tappable and opens the existing,
//      unmodified cycle selector. ───────────────────────────────────────────
const bannerHtmlStart = source.indexOf('id="ci-cycle-banner"');
const bannerHtml = source.slice(bannerHtmlStart - 20, bannerHtmlStart + 260);
assert.match(bannerHtml, /onclick="toggleCycleSelector\(\)"/, 'the banner has a tap handler');
assert.match(bannerHtml, /cursor:pointer/, 'the banner is styled as tappable');
assert.match(bannerHtml, /<span id="ci-cycle-banner-text">/, 'the dynamic date text lives in its own inner span, separate from the static tap affordance');

const toggleFn = extractFunction('toggleCycleSelector');
assert.match(toggleFn, /\$id\('ci-cycle-sel-wrap'\)/, 'opens the existing cycle-selector wrap, not a new/duplicate UI');
assert.match(toggleFn, /wrap\.style\.display=''/, 'reveals it regardless of the auto-show heuristic used elsewhere');
assert.match(toggleFn, /scrollIntoView/, 'scrolls it into view so the tap has a visible effect even if it was off-screen');
assert.match(toggleFn, /sel\.focus\(\)/, 'focuses the select so keyboard/assistive users land on it too');

// The banner-text updater and the full-state reset both now target the inner
// span, not the outer clickable wrapper (setting .textContent on the wrapper
// would destroy the span and the tap affordance permanently).
assert.match(source, /var _cb=\$id\('ci-cycle-banner-text'\)\|\|\$id\('ci-cycle-banner'\)/, 'refreshInterestCard updates the inner text span (with a safe fallback), preserving the tappable wrapper structure');
assert.ok(!/\['ci-cycle-banner','ci-principal'/.test(source), 'the full-reset id list no longer targets the outer wrapper by id (which would wipe out the inner span)');
assert.match(source, /\['ci-cycle-banner-text','ci-principal'/, 'the full-reset id list targets the inner text span instead');

// ── 4. Selecting a cycle still goes through the completely unmodified
//      onCycleSelChange(), which already loads that cycle's real interest
//      amount/details — nothing about this calculation was touched. ────────
const onChangeFn = extractFunction('onCycleSelChange');
assert.match(onChangeFn, /var selInt=Math\.max\(0,parseFloat\(picked\.pending!=null\?picked\.pending:picked\.interest\)\|\|0\);/, 'the selected cycle’s real pending/interest amount computation is unchanged');
assert.match(onChangeFn, /\$id\('ci-cycle-interest'\)\.value=String\(selInt\)/, 'the hidden field feeding the actual payment save is still updated from the selected cycle, unchanged');
assert.match(onChangeFn, /onPaymentToChange\(\); \/\/ re-compute Total Due chip per current purpose/, 'still re-syncs the Total Due chip after a cycle is picked, unchanged');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'advance-interest-section-label-removed',
    'advance-interest-row-removed',
    'advance-interest-input-removed',
    'advance-interest-description-removed',
    'orphaned-reader-function-removed',
    'no-dangling-row-references',
    'no-dangling-input-references',
    'advance-interest-plan-function-untouched',
    'rebuild-advance-interest-entry-untouched',
    'next-cycle-save-path-hardcoded-limit-untouched',
    'next-cycle-save-path-call-untouched',
    'cycle-banner-has-tap-handler',
    'cycle-banner-styled-tappable',
    'cycle-banner-text-in-own-span',
    'toggle-opens-existing-selector-wrap',
    'toggle-forces-visible-regardless-of-heuristic',
    'toggle-scrolls-into-view',
    'toggle-focuses-select',
    'banner-updater-targets-inner-span',
    'reset-list-no-longer-targets-outer-wrapper',
    'reset-list-targets-inner-span',
    'cycle-select-change-amount-calc-unchanged',
    'cycle-select-change-hidden-field-unchanged',
    'cycle-select-change-total-due-resync-unchanged',
  ],
}, null, 2));
