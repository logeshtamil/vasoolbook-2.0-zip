'use strict';

// Verifies the Collection Entry success notification fix: after a
// Collection Entry saves successfully, the large centered VBProcessing
// "✓ Completed successfully" overlay (with its translucent, tap-blocking
// backdrop held for ~900ms) no longer appears at all — so it can never
// block/shift/cover the Collection/Send Message popup that the app already
// shows right after (either the rich showSavePopup modal, or the existing
// small top-anchored _showPaymentSuccessNotification banner on the
// lightweight path). The user can immediately continue/send the message or
// change Area without waiting on anything.
//
// Root cause: _proceedSaveEntry/_proceedSaveEntryNextCycle (Payment Save)
// are wrapped by VBProcessing.wrapFunction, whose success completion
// (complete(token,'success')) defaults its text to "Completed successfully"
// and holds the centered box + translucent backdrop up for STATUS_HOLD
// (~900ms) before auto-closing — sitting on top of whatever the collection
// save flow shows next.
//
// Fix: VBProcessing.run() gained an opt-in `silentSuccess` option — on a
// genuine save success it now calls end(token) instead of
// complete(token,'success'), closing instantly with no checkmark flash and
// no hold delay (still fully unlocking the UI either way). A genuine
// FAILURE is completely unaffected — it still shows the normal "✕ Failed"
// flash. The flag is wired ONLY onto the two Payment Save entries; every
// other wrapped action (Loan Save/Edit, Top-Up, backups, exports, etc.)
// keeps its existing success-flash behavior unchanged.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractVar(name) {
  const marker = `var ${name}=`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `var ${name} exists`);
  const iifeEnd = source.indexOf('})();', start);
  assert.ok(iifeEnd > start, `var ${name} is an IIFE`);
  return source.slice(start, iifeEnd + '})();'.length);
}

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

// ── 1. Source-level: both Payment Save entries opt into silentSuccess. ─────
const wireBlock = extractFunction('_installGlobalProcessingIndicators');
assert.match(wireBlock, /\['_proceedSaveEntry',\{key:'payment-save'[\s\S]*?silentSuccess:true\}\]/, 'direct payment save opts into silent success');
assert.match(wireBlock, /\['_proceedSaveEntryNextCycle',\{key:'payment-cycle-save'[\s\S]*?silentSuccess:true\}\]/, 'credit-to-next-cycle payment save opts into silent success');
// No other entry in the list was flagged — this is scoped to Payment Save only.
const otherEntries = wireBlock.match(/\['[a-zA-Z_]+',\{[^\]]*?\}\]/g).filter(e => !e.includes('payment-save') && !e.includes('payment-cycle-save'));
otherEntries.forEach(entry => {
  assert.doesNotMatch(entry, /silentSuccess/, `unrelated wrapped action stays unaffected: ${entry}`);
});

function buildProcessingContext() {
  const elementsById = {};
  function makeFakeEl() {
    const children = [];
    const el = {
      style: {}, attrs: {}, children,
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { children.push(c); if (c && c.id) elementsById[c.id] = c; return c; },
      querySelector(sel) {
        if (sel === '.vb-processing-spin') return makeFakeEl();
        if (sel === '.vb-processing-text') return makeFakeEl();
        return null;
      },
    };
    return el;
  }
  const context = {
    Object,
    document: {
      getElementById: id => elementsById[id] || null,
      createElement: () => makeFakeEl(),
      head: makeFakeEl(), documentElement: makeFakeEl(), body: makeFakeEl(),
    },
    window: {}, setTimeout, clearTimeout,
    showToast: () => {},
  };
  vm.createContext(context);
  vm.runInContext(extractVar('VBProcessing'), context);
  return context;
}

// ── 2. Behavioral: a silentSuccess save closes instantly with NO visible
//      "Completed successfully" state and no lingering backdrop. ───────────
{
  const ctx = buildProcessingContext();
  const result = ctx.VBProcessing.run('payment-save', 'Saving payment…', function () {
    return undefined; // real save path, no exception, not `false`
  }, { delay: 0, silentSuccess: true });
  assert.strictEqual(result, undefined, 'the save\'s own return value passes through unchanged');
  const box = ctx.document.getElementById('vb-processing-indicator');
  assert.ok(!box || box.attrs['data-state'] !== 'success', 'no lingering "success" checkmark state is left on the overlay');
  // Proves the token was fully released (end(), not complete()+hold) — a
  // brand-new operation under the same key can start immediately, with no
  // leftover backdrop/hold blocking it.
  const reopened = ctx.VBProcessing.begin('payment-save', 'Saving payment…', { delay: 0 });
  assert.ok(reopened, 'the key is immediately free for reuse — no hold-timer left the previous token "active"');
  ctx.VBProcessing.end(reopened);
}

// ── 3. A genuine FAILURE is completely unaffected by silentSuccess — it
//      still shows the normal error state before the caller can inspect it. ──
{
  const ctx = buildProcessingContext();
  let threw = null;
  try {
    ctx.VBProcessing.run('payment-save', 'Saving payment…', function () {
      throw new Error('storage full');
    }, { delay: 0, silentSuccess: true });
  } catch (e) { threw = e; }
  assert.ok(threw && threw.message === 'storage full', 'the exception still propagates to the caller');
  const box = ctx.document.getElementById('vb-processing-indicator');
  assert.strictEqual(box.attrs['data-state'], 'error', 'a genuine failure still shows the normal ✕ Failed state — silentSuccess only suppresses the SUCCESS flash');
}

// ── 4. An un-flagged action (e.g. Loan Save/Edit) is completely unaffected —
//      it still shows the success checkmark exactly as before this fix. ────
{
  const ctx = buildProcessingContext();
  ctx.VBProcessing.run('loan-save', 'Saving loan…', function () { return undefined; }, { delay: 0 }); // no silentSuccess
  const box = ctx.document.getElementById('vb-processing-indicator');
  assert.strictEqual(box.attrs['data-state'], 'success', 'un-flagged actions keep their existing "✓ Completed successfully" flash, unchanged');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'payment-save-opts-into-silent-success',
    'payment-cycle-save-opts-into-silent-success',
    'no-other-action-affected-source-level',
    'silent-success-return-value-passthrough',
    'silent-success-no-lingering-checkmark',
    'silent-success-key-immediately-reusable',
    'failure-still-propagates',
    'failure-still-shows-error-state',
    'unflagged-action-keeps-success-flash',
  ],
}, null, 2));
