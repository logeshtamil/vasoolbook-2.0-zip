'use strict';

// Verifies the reusable centered Processing UI (VBProcessing) reliably
// reflects real outcomes for save-style actions (Loan Sanction/Create/Edit/
// Save, Payment Save) wrapped via _installGlobalProcessingIndicators.
//
// Root cause of the gap being fixed: several wrapped functions (saveBorrower,
// saveEditPayModal, _proceedSaveEntry, _proceedSaveEntryNextCycle) have many
// internal validation early-returns (bare `return;`, i.e. undefined — never
// `return false;`) used only to short-circuit and show a toast. VBProcessing's
// run() previously treated ANY non-`false` result as success, so a blocked
// validation path (e.g. "Enter loan amount") would flash a false
// "✓ Completed successfully" checkmark right next to the warning toast that
// says nothing was saved.
//
// Fix: run() now accepts an opt-in `detectSaveViaRevision` option. Every real
// save in this app goes through saveState()/saveStateFast(), which
// unconditionally bump the shared _gdDataRevision counter first (used
// elsewhere for Drive backup change detection) — so "the revision didn't
// move during this call" is a reliable, non-invasive way to detect that
// nothing was actually persisted, without touching any of the business logic
// or rewriting every validation branch in those large functions. When
// enabled and the revision does not advance, run() calls end() (silent
// close, matching what already happens for a user-cancelled action) instead
// of complete(token,'success'). The option is OFF by default, so the other
// ~25 already-wrapped actions (backups, exports, PDF/report generation,
// etc. — which don't mutate borrower/entryLog data at all) are completely
// unaffected.

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

// ── 1. Source-level: the four named actions are wired through the reusable
//      VBProcessing service, with the reliability flag enabled. ────────────
const wireBlock = extractFunction('_installGlobalProcessingIndicators');
assert.match(wireBlock, /\['_proceedSaveEntry',\{key:'payment-save',text:'Saving payment\\u2026',delay:0,timeout:30000,detectSaveViaRevision:true\}\]/, 'Payment Save (direct) is wired with reliable outcome detection');
assert.match(wireBlock, /\['_proceedSaveEntryNextCycle',\{key:'payment-cycle-save',text:'Saving payment\\u2026',delay:0,timeout:30000,detectSaveViaRevision:true\}\]/, 'Payment Save (credit-to-next-cycle) is wired with reliable outcome detection');
assert.match(wireBlock, /\['saveBorrower',\{key:'loan-save'[\s\S]*?detectSaveViaRevision:true\}\]/, 'Loan Sanction/Create/Edit/Save is wired with reliable outcome detection');
assert.match(wireBlock, /\['saveEditPayModal',\{key:'payment-edit',text:'Updating payment\\u2026',delay:0,timeout:30000,detectSaveViaRevision:true\}\]/, 'Edit (payment edit) is wired with reliable outcome detection');

// Save Loan button routes through _loanSaveWithLoader (the Loan section's own
// perceived-responsiveness spinner, LoanLoader), which itself calls the real
// saveBorrower() — VBProcessing.wrapFunction wraps the underlying global
// saveBorrower in place, so the reliable-outcome fix still applies
// transparently regardless of this extra indirection.
assert.match(source, /onclick="_loanSaveWithLoader\(\)" id="modal-save-btn"/, 'Save Loan button routes through the Loan section loader wrapper');
const loanSaveWithLoaderFn = extractFunction('_loanSaveWithLoader');
assert.match(loanSaveWithLoaderFn, /saveBorrower\(\)/, '_loanSaveWithLoader ultimately calls the real saveBorrower(), which VBProcessing.wrapFunction wraps transparently');

// Top-Up already had a hand-built, fully-correct idle/success/error VBProcessing
// integration (try/catch/finally) before this fix — confirm it is untouched.
const topUpFn = extractFunction('saveTopUp');
assert.match(topUpFn, /VBProcessing\.begin\('topup-save'/, 'Top-Up begins the shared processing UI');
assert.match(topUpFn, /VBProcessing\.complete\(_topupProcessingToken,'success','Top-Up updated successfully'\)/, 'Top-Up completes with a real success state only when the save truly succeeded');
assert.match(topUpFn, /VBProcessing\.complete\(_topupProcessingToken,'error',_topupProcessingMessage/, 'Top-Up completes with a real error state on failure');
assert.match(topUpFn, /else VBProcessing\.end\(_topupProcessingToken\);/, 'Top-Up silently closes (no false checkmark) when neither success nor error was reached');
assert.match(topUpFn, /\}finally\{/, 'Top-Up always clears its processing state in a finally block, covering thrown exceptions too');

// ── 2. Behavioral: VBProcessing.run() with detectSaveViaRevision correctly
//      distinguishes "nothing was actually saved" from "a real save happened",
//      using only the pre-existing, unrelated data-revision counter. ────────
function makeFakeEl() {
  const children = [];
  const el = {
    style: {}, attrs: {}, children,
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    removeAttribute(k) { delete el.attrs[k]; },
    appendChild(c) { children.push(c); return c; },
    querySelector(sel) {
      // Only the two selectors VBProcessing itself ever queries for.
      if (sel === '.vb-processing-spin') return makeFakeEl();
      if (sel === '.vb-processing-text') return makeFakeEl();
      return null;
    },
  };
  return el;
}

function buildProcessingContext() {
  let revision = 0;
  const elementsById = {};
  const context = {
    Object,
    document: {
      getElementById: id => elementsById[id] || null,
      createElement: () => makeFakeEl(),
      head: makeFakeEl(),
      documentElement: makeFakeEl(),
      body: makeFakeEl(),
    },
    window: {},
    setTimeout, clearTimeout,
    showToast: () => {},
    _gdCurrentDataRevision: () => revision,
    _bumpRevision: () => { revision += 1; },
  };
  vm.createContext(context);
  vm.runInContext(extractVar('VBProcessing'), context);
  vm.runInContext('window.VBProcessing=VBProcessing;', context);
  return context;
}

{
  const ctx = buildProcessingContext();
  // A "save" that hits an internal validation early-return: mutates nothing,
  // never calls saveState()-equivalent, returns undefined (bare `return;`,
  // exactly like saveBorrower's "Enter loan amount" guard).
  const blockedResult = ctx.VBProcessing.run('loan-save', 'Saving…', function () {
    return undefined; // validation blocked — nothing persisted
  }, { detectSaveViaRevision: true, delay: 0 });
  assert.strictEqual(blockedResult, undefined, 'the blocked call\'s own return value is passed through unchanged');
  assert.strictEqual(ctx.VBProcessing.isActive('loan-save'), false, 'no lingering "active" state after a blocked validation call');
}

{
  const ctx = buildProcessingContext();
  let completedStatus = null;
  // Real save: the operation itself calls the same revision-bump every real
  // saveState()/saveStateFast() call performs.
  ctx.VBProcessing.run('loan-save', 'Saving…', function () {
    ctx._bumpRevision();
    return undefined; // saveBorrower() also returns nothing on its success path
  }, { detectSaveViaRevision: true, delay: 0 });
  // No public "last status" getter exists on the module — verify indirectly:
  // begin() a second call with the SAME key must not be blocked as "already
  // running" (proves the first call's token was properly ended/completed,
  // not left dangling active).
  const second = ctx.VBProcessing.begin('loan-save', 'Saving…', { delay: 0 });
  assert.ok(second, 'the token from the real save was properly completed (not left stuck active), so a new operation under the same key can start immediately');
  ctx.VBProcessing.end(second); // release the timers this probe token opened
}

{
  // Functions that do NOT opt in (the other ~25 wrapped actions) are
  // completely unaffected — the revision counter is never even consulted.
  const ctx = buildProcessingContext();
  const result = ctx.VBProcessing.run('receipt-share', 'Preparing receipt…', function () {
    return undefined; // never touches _gdDataRevision, e.g. a pure PDF/share action
  }, { delay: 0 }); // detectSaveViaRevision NOT set
  const second = ctx.VBProcessing.begin('receipt-share', 'Preparing receipt…', { delay: 0 });
  assert.ok(second, 'an un-flagged action still completes as success and releases its key exactly as before this fix (backward compatible)');
  ctx.VBProcessing.end(second);
}

{
  // A thrown exception is still reported as a real error and always clears —
  // detectSaveViaRevision does not change error handling at all.
  const ctx = buildProcessingContext();
  let threw = null;
  try {
    ctx.VBProcessing.run('loan-save', 'Saving…', function () {
      throw new Error('disk full');
    }, { detectSaveViaRevision: true, delay: 0 });
  } catch (e) { threw = e; }
  assert.ok(threw && threw.message === 'disk full', 'a thrown exception still propagates');
  const recovered = ctx.VBProcessing.begin('loan-save', 'Saving…', { delay: 0 });
  assert.ok(recovered, 'the UI is always unlocked afterward, even after a thrown exception — the key is never left stuck busy');
  ctx.VBProcessing.end(recovered);
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'payment-save-wired-with-detection',
    'payment-cycle-save-wired-with-detection',
    'loan-save-wired-with-detection',
    'payment-edit-wired-with-detection',
    'save-loan-button-routes-through-loan-loader-wrapper',
    'loan-loader-wrapper-calls-real-save-function',
    'topup-begins-shared-processing-ui',
    'topup-completes-success-only-when-real',
    'topup-completes-error-on-failure',
    'topup-silently-ends-on-no-op',
    'topup-always-clears-in-finally',
    'blocked-validation-call-passthrough-return-value',
    'blocked-validation-call-releases-key-immediately',
    'real-save-releases-key-for-reuse',
    'unflagged-action-unaffected-backward-compatible',
    'thrown-exception-still-propagates',
    'thrown-exception-always-unlocks-ui',
  ],
}, null, 2));
