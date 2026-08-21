'use strict';

// Verifies the Payment Successful notification (the lightweight path used
// when "Show Collection Success Popup" is OFF) is shown via the existing
// centered, fixed, auto-closing VBProcessing overlay instead of the old
// bottom-anchored toast — so it can never push/shift/reflow the borrower
// list underneath. The rich receipt-sharing popup (showSavePopup) is
// untouched — auto-closing IT would break its share buttons.

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

// ── 1. Both real collection-save call sites use the new centered helper,
//      not the old bottom-anchored toast directly.
const callSites = [...source.matchAll(/showToast\('✅ Payment Success',1000\);\s*\n\s*_scheduleCollectionPostSaveNavigation\(\);/g)];
assert.strictEqual(callSites.length, 0, 'no remaining raw toast call sites feeding the post-save navigation flow');
const helperCallSites = [...source.matchAll(/_showPaymentSuccessNotification\(\);\s*\n\s*_scheduleCollectionPostSaveNavigation\(\);/g)];
assert.strictEqual(helperCallSites.length, 2, 'both collection-save flows (normal + advance-interest) use the new centered notification helper');

// ── 2. The helper itself: uses VBProcessing (centered, fixed, auto-close),
//      with a toast fallback only if VBProcessing is ever unavailable.
const helperSource = extractFunction('_showPaymentSuccessNotification');
assert.match(helperSource, /VBProcessing\.begin\(/, 'uses the existing centered/fixed VBProcessing overlay');
assert.match(helperSource, /VBProcessing\.complete\(_t,'success','Payment Successful'\)/, 'immediately completes to the success state, which auto-closes after VBProcessing\'s existing STATUS_HOLD');
assert.match(helperSource, /showToast\('✅ Payment Success',1000\)/, 'keeps a safe toast fallback if VBProcessing is ever unavailable');

// ── 3. VBProcessing itself is confirmed centered/fixed/non-reflowing and
//      auto-closing (source-level, re-asserting the underlying contract this
//      fix relies on).
assert.match(source, /#vb-processing-indicator\{position:fixed;top:50%;left:50%;transform:translate\(-50%,-50%\)/, 'VBProcessing is fixed-positioned and centered — cannot affect document flow/layout of sibling content');
assert.match(source, /token\.closeTimer=setTimeout\(function\(\)\{end\(token\);\}/, 'VBProcessing auto-closes itself after the success hold period');

// ── 4. The rich receipt-sharing popup (showSavePopup / #savePopup) is
//      completely untouched by this change — it still shows on the "Show
//      Collection Success Popup" ON path, unaffected.
const showSavePopupCallSites = [...source.matchAll(/showSavePopup\(_freshSavedBorrower,today,total,bal,payVal,dateVal\);/g)];
assert.ok(showSavePopupCallSites.length >= 2, 'showSavePopup is still called unchanged on the popup-enabled path');

// ── 5. Payment save/calculation logic itself is untouched — this is a pure
//      presentation change (source-level sanity check on the surrounding code).
assert.doesNotMatch(helperSource, /entryLog\.push|principalComponent|interestComponent|saveStateFast/, '_showPaymentSuccessNotification never touches save/calculation logic — display only');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'no-raw-toast-call-sites-remain',
    'both-flows-use-new-centered-helper',
    'helper-uses-vbprocessing-begin-complete',
    'helper-has-toast-fallback',
    'vbprocessing-confirmed-fixed-centered',
    'vbprocessing-confirmed-auto-close',
    'showSavePopup-path-untouched',
    'notification-helper-never-touches-calculations',
  ],
}, null, 2));
