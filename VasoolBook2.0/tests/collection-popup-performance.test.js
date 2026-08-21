'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('www/index.html', 'utf8');
const java = fs.readFileSync(
  'android/app/src/main/java/in/vasoolbook/app/MainActivity.java',
  'utf8'
);

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const showPopup = extractFunction(html, 'showSavePopup');
const popupBuilder = extractFunction(html, '_rebuildSavePopupDOM');
const whatsappAction = extractFunction(html, 'openPopupWhatsApp');
const closePopup = extractFunction(html, 'closePopup');
const receiptAction = extractFunction(html, 'sendReceiptToWA');
const receiptRender = extractFunction(html, '_renderReceiptBlob');
const shareDispatch = extractFunction(html, '_shareReceiptBlob');
const saveFlowStart = html.indexOf('function _proceedSaveEntry(');
const nextCycleSaveFlowStart = html.indexOf('function _proceedSaveEntryNextCycle(');
const saveFlow = html.slice(saveFlowStart, nextCycleSaveFlowStart);
const nextCycleSaveFlow = html.slice(nextCycleSaveFlowStart, html.indexOf('// LOAN MODAL CALCULATIONS', nextCycleSaveFlowStart));
assert.ok(saveFlowStart >= 0 && nextCycleSaveFlowStart > saveFlowStart, 'collection save functions exist');

assert.doesNotMatch(showPopup, /_preRenderReceiptBlob\s*\(/, 'popup open must not rasterize a receipt');
assert.match(showPopup, /_cachedReceiptEntry\s*=\s*_popEntry/, 'popup keeps a stable lightweight receipt snapshot');
assert.match(whatsappAction, /openWhatsAppMessage\(share\.phone,share\.msg\)/, 'WhatsApp text opens on its first tap');
assert.doesNotMatch(whatsappAction, /setTimeout|_popupShareBusy|html2canvas/, 'WhatsApp text action has no artificial delay');
assert.match(popupBuilder, /sendReceiptToWA\(rcBtn\)/, 'receipt share is wired to its exact button');
assert.match(popupBuilder, /downloadReceiptFromPopup\(dlBtn\)/, 'receipt download is wired to its exact button');
assert.match(popupBuilder, /closePopup\(true\);[\s\S]*openNewLoanForCustomer\(newLoanBid\)/, 'New Loan closes and navigates on one tap');
assert.match(popupBuilder, /clBtn\.addEventListener\('click'[\s\S]*closePopup\(\)/, 'Close is wired directly');
assert.doesNotMatch(closePopup, /if\s*\(\s*_popupShareBusy/, 'Close must never be blocked by a share flag');
assert.match(closePopup, /_flushCollectionPostSaveUpkeep\s*\(/, 'deferred UI upkeep flushes after close');
assert.match(receiptAction, /_beginPopupAction\s*\(\s*btn\s*\)/, 'receipt action has per-button duplicate protection');
assert.match(receiptAction, /finally[\s\S]*_endPopupAction\s*\(\s*btn\s*\)/, 'receipt action always restores its button');
assert.match(receiptAction, /_vbWithTimeout\s*\(\s*_preRenderReceiptBlob\(\)/, 'receipt preparation has a hard timeout');
assert.match(receiptRender, /scale\|\|2/, 'mobile receipt rendering uses the lighter scale');
assert.match(receiptRender, /Receipt rendering/, 'html2canvas has a timeout');
assert.match(receiptRender, /function cleanup\(\)/, 'off-screen receipt DOM is always cleaned');
assert.match(shareDispatch, /Dispatch only/, 'web share is dispatched without waiting for app closure');
assert.match(saveFlow, /_queueCollectionPostSaveUpkeep\(bid,today\)/, 'normal saves defer bulk UI refresh');
assert.match(nextCycleSaveFlow, /_queueCollectionPostSaveUpkeep\(bid,today\)/, 'next-cycle saves defer bulk UI refresh');
assert.doesNotMatch(java, /CountDownLatch|latch\.await/, 'native intent bridges must not block JavaScript');
assert.match(java, /runOnUiThread\(\(\) -> \{[\s\S]*startActivity\(intent\)/, 'native intents are queued on the UI thread');
assert.match(java, /return null;\s*\n\s*}\s*\n\s*\n\s*private String tryOpenImage/, 'text share returns after dispatch');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'no-eager-html2canvas',
    'stable-receipt-snapshot',
    'close-always-clickable',
    'new-loan-independent-navigation',
    'per-action-duplicate-guard',
    'timeout-and-finally-cleanup',
    'deferred-post-save-render',
    'nonblocking-web-share-dispatch',
    'nonblocking-native-intent-dispatch'
  ]
}, null, 2));
