'use strict';

// Verifies the new reusable Loan-section processing loader: a rotating
// radial-bar spinner shown only after a 3s delay (so fast saves never flash
// it), always force-hidden on finish/failure via the Save Loan button's
// wrapper, and never left stuck onscreen thanks to a watchdog timeout and
// depth-counted show/hide pairing.

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

function extractVar(name) {
  const marker = `var ${name}=`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `var ${name} exists`);
  const iifeEnd = source.indexOf('})();', start);
  assert.ok(iifeEnd > start, `var ${name} is an IIFE`);
  return source.slice(start, iifeEnd + '})();'.length);
}

// ── 1. Save Loan button now routes through the loader wrapper, not saveBorrower() directly.
assert.ok(source.includes('onclick="_loanSaveWithLoader()" id="modal-save-btn"'), 'Save Loan button calls the loader-wrapped save function');
assert.ok(!/onclick="saveBorrower\(\)" id="modal-save-btn"/.test(source), 'no remaining direct saveBorrower() wiring on the Save Loan button');

// ── 2. The wrapper always hides the loader, even if saveBorrower() throws.
const wrapperSource = extractFunction('_loanSaveWithLoader');
assert.match(wrapperSource, /showLoanProcessingLoader\(\)/, 'shows the loader before saving');
assert.match(wrapperSource, /try\{\s*saveBorrower\(\);\s*\}\s*finally\{\s*hideLoanProcessingLoader\(\);\s*\}/, 'saveBorrower() is called inside try/finally so the loader is always hidden, even on a thrown error');

// ── 3. Behavioral: LoanLoader show/hide lifecycle — DOM built lazily, hidden
//    by default, only reveals after the 3s delay, and a watchdog exists so it
//    can never get stuck onscreen if a caller forgets to hide it.
{
  class FakeClassList {
    constructor(){ this.set = new Set(); }
    add(c){ this.set.add(c); }
    remove(c){ this.set.delete(c); }
    contains(c){ return this.set.has(c); }
  }
  class FakeEl {
    constructor(tag){ this.tag = tag; this.style = {}; this.children = []; this.classList = new FakeClassList(); this.attrs = {}; }
    appendChild(c){ this.children.push(c); return c; }
    setAttribute(k, v){ this.attrs[k] = v; }
    set innerHTML(v){ this._html = v; }
    get innerHTML(){ return this._html; }
  }
  const head = new FakeEl('head'), body = new FakeEl('body');
  const timers = []; // {fn, delay}
  let idCounter = 0;
  const context = {
    document: {
      createElement: tag => new FakeEl(tag),
      head, body, documentElement: head,
    },
    setTimeout: (fn, delay) => { const id = ++idCounter; timers.push({ id, fn, delay, cleared: false }); return id; },
    clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
  };
  vm.createContext(context);
  vm.runInContext(extractVar('LoanLoader'), context);
  vm.runInContext(extractFunction('showLoanProcessingLoader'), context);
  vm.runInContext(extractFunction('hideLoanProcessingLoader'), context);

  // Nothing built until first show().
  assert.strictEqual(body.children.length, 0, 'no DOM node created until the loader is first shown');

  context.showLoanProcessingLoader();
  assert.strictEqual(body.children.length, 1, 'exactly one loader element is created');
  const el = body.children[0];
  assert.strictEqual(el.attrs['aria-hidden'], 'true', 'not yet revealed immediately after show() — waits for the delay');
  assert.ok(!el.classList.contains('show'), 'the "show" class is not applied before the delay elapses');

  // Fire the 3000ms reveal timer.
  const revealTimer = timers.find(t => t.delay === 3000 && !t.cleared);
  assert.ok(revealTimer, 'a 3-second delay timer is scheduled before the loader becomes visible');
  revealTimer.fn();
  assert.ok(el.classList.contains('show'), 'after the 3s delay elapses, the loader becomes visible');
  assert.strictEqual(el.attrs['aria-hidden'], 'false');

  // hide() clears it immediately, regardless of the delay/watchdog timers.
  context.hideLoanProcessingLoader();
  assert.ok(!el.classList.contains('show'), 'hide() immediately removes the visible loader');
  assert.strictEqual(el.attrs['aria-hidden'], 'true');

  // A 45s watchdog exists as a stuck-onscreen safety net.
  const watchdog = timers.find(t => t.delay === 45000);
  assert.ok(watchdog, 'a 45-second watchdog timeout is scheduled as a safety net against a forgotten hide() call');
}

// ── 4. Nested show/hide: an inner call never hides a loader an outer caller still needs.
{
  class FakeClassList { constructor(){ this.set = new Set(); } add(c){ this.set.add(c); } remove(c){ this.set.delete(c); } contains(c){ return this.set.has(c); } }
  class FakeEl { constructor(tag){ this.tag = tag; this.style = {}; this.children = []; this.classList = new FakeClassList(); this.attrs = {}; } appendChild(c){ this.children.push(c); return c; } setAttribute(k,v){ this.attrs[k]=v; } set innerHTML(v){ this._html=v; } get innerHTML(){ return this._html; } }
  const head = new FakeEl('head'), body = new FakeEl('body');
  const timers = []; let idCounter = 0;
  const context = {
    document: { createElement: tag => new FakeEl(tag), head, body, documentElement: head },
    setTimeout: (fn, delay) => { const id = ++idCounter; timers.push({ id, fn, delay, cleared: false }); return id; },
    clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
  };
  vm.createContext(context);
  vm.runInContext(extractVar('LoanLoader'), context);
  vm.runInContext(extractFunction('showLoanProcessingLoader'), context);
  vm.runInContext(extractFunction('hideLoanProcessingLoader'), context);

  context.showLoanProcessingLoader(); // outer
  context.showLoanProcessingLoader(); // inner
  const el = body.children[0];
  timers.filter(t => t.delay === 3000 && !t.cleared).slice(-1)[0].fn();
  assert.ok(el.classList.contains('show'), 'visible after both shows');

  context.hideLoanProcessingLoader(); // inner finishes first
  assert.ok(el.classList.contains('show'), 'still visible — the outer call is still in flight');

  context.hideLoanProcessingLoader(); // outer finishes
  assert.ok(!el.classList.contains('show'), 'hidden once every nested show() has a matching hide()');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'save-loan-button-uses-loader-wrapper',
    'no-direct-savebbrower-wiring-remains',
    'wrapper-shows-then-try-finally-hides',
    'loader-dom-built-lazily',
    'loader-hidden-until-3s-delay-elapses',
    'loader-reveals-after-delay',
    'hide-immediately-clears-visible-loader',
    'watchdog-timeout-scheduled-as-safety-net',
    'nested-show-hide-outer-call-not-hidden-by-inner-finish',
    'nested-show-hide-hidden-once-fully-unwound',
  ],
}, null, 2));
