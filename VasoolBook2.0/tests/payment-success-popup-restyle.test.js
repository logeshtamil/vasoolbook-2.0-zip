'use strict';

// Verifies the Payment/Collection success popup (#savePopup, built by
// _rebuildSavePopupDOM — "Entry Saved!" / "Loan Fully Paid!" / "Payment
// Receipt") was restyled to the same centered-modal pattern already
// established elsewhere in the app (io-modal-bg/io-modal: fixed, centered,
// fully rounded, popIn animation) instead of the old bottom sheet
// (align-items:flex-end, top-corners-only, slideUp).
//
// Scoping check is the important part: the shared .popup-bg/.popup classes
// (used by every OTHER bottom-sheet popup — Appointment, etc.) must stay
// completely untouched. Only #savePopup gets ID-scoped overrides. And the
// actual receipt/share workflow (WhatsApp, Receipt Share, Copy, Close) must
// be byte-for-byte unchanged — only the outer positioning/animation moved.

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('www/index.html', 'utf8');

// ── 1. #savePopup now centers instead of bottom-anchoring, and reuses the
//      established popIn animation (same one io-modal already uses).
assert.match(source, /#savePopup\.popup-bg\{align-items:center;justify-content:center/, '#savePopup is centered, not bottom-anchored');
assert.match(source, /#savePopup \.popup\{[^}]*animation:popIn \.3s cubic-bezier\(\.34,1\.56,\.64,1\)/, '#savePopup reuses the established popIn centered-modal animation');
assert.match(source, /#savePopup \.popup\{[^}]*border-radius:20px/, '#savePopup card is fully rounded (not just the top corners of the old bottom sheet)');

// ── 2. The shared .popup-bg/.popup classes (every OTHER bottom-sheet popup)
//      are completely untouched — still bottom-anchored with slideUp.
assert.match(source, /\.popup-bg\{display:none;position:fixed;inset:0;background:rgba\(0,0,0,\.6\);z-index:700;align-items:flex-end/, 'the shared .popup-bg class is unchanged (other bottom-sheet popups keep their exact existing behavior)');
assert.match(source, /\.popup\{background:#fff;border-radius:22px 22px 0 0;width:100%;max-width:100%;overflow-y:auto;max-height:92dvh;padding-bottom:env\(safe-area-inset-bottom\);animation:slideUp \.3s ease\}/, 'the shared .popup class definition (bottom sheet, slideUp) is unchanged');

// ── 3. The Appointment popup (a different, unrelated bottom-sheet popup)
//      still explicitly uses align-items:flex-end — proving the restyle did
//      not leak into other popups sharing similar markup.
assert.match(source, /id="appointmentPopup"[^>]*align-items:flex-end/, 'the Appointment popup (unrelated) keeps its own bottom-sheet layout untouched');

// ── 4. The actual receipt/share workflow inside _rebuildSavePopupDOM is
//      untouched — same buttons, same handlers, same info rows.
const fnStart = source.indexOf('function _rebuildSavePopupDOM(');
assert.ok(fnStart >= 0, '_rebuildSavePopupDOM exists');
const fnBody = source.slice(fnStart, fnStart + 6000);
['openPopupWhatsApp', 'pop-wa', 'pop-img', 'Send Receipt', 'pop-info', 'pop-row'].forEach(marker => {
  assert.ok(fnBody.includes(marker), `_rebuildSavePopupDOM still includes ${marker} — receipt/share workflow untouched`);
});

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'save-popup-centered-not-bottom-sheet',
    'save-popup-reuses-established-popin-animation',
    'save-popup-fully-rounded',
    'shared-popup-bg-class-unchanged',
    'shared-popup-class-unchanged',
    'appointment-popup-unaffected',
    'receipt-share-workflow-untouched',
  ],
}, null, 2));
