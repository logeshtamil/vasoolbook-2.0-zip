'use strict';

// Regression test for "session expires while the app is still open" bug.
//
// Before the fix: an expired/cleared session was only ever detected lazily,
// the next time some protected action happened to call _mumRequire — and even
// then _mumRequire only showed a toast ("Sign in is required for this
// action"), never the actual Sign In screen. A user who was just reading /
// scrolling (never triggering a protected action) could sit behind a dead
// session indefinitely with zero indication, then hit confusing silent
// no-ops, with no way back to Sign In short of a force-close/reopen.
//
// After the fix: _mumBindSessionLifecycle wires a periodic check plus
// appStateChange/focus listeners that edge-trigger on the signed-in ->
// signed-out transition and immediately raise the Sign In gate (as an
// overlay — never a page reload, so the underlying screen/unsaved form is
// preserved). _mumRequire also raises the gate immediately (not just a
// toast) whenever there is no current user at all, distinct from a
// same-user-insufficient-role denial which stays a toast only.

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

let currentUser = null;
const gateCalls = [];
const timers = []; // [ms, fn]
const listeners = { focus: [], appStateChange: [] };

const context = {
  window: {
    Capacitor: { Plugins: { App: { addListener(evt, fn) { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); } } } },
    addEventListener(evt, fn) { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); },
  },
  document: { hidden: false, addEventListener(evt, fn) { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); } },
  setInterval(fn, ms) { timers.push([ms, fn]); return timers.length; },
  _mumCurrentUser() { return currentUser; },
  _mumValidUsers() { return currentUser ? [currentUser] : []; },
  mumShowAuthMode(mode, reason) { gateCalls.push({ mode, reason }); },
  syncAudit() {},
  showToast() {},
  _MUM_ROLE_PERMISSIONS: {
    Admin: ['*'],
    Collector: ['payment.create'],
  },
  _mumLastKnownSignedIn: false,
  _mumSessionLifecycleBound: false,
};
vm.createContext(context);
['_mumShowAuthGate', '_mumSessionWatchdogCheck', '_mumBindSessionLifecycle', '_mumCan', '_mumRequire']
  .forEach(name => vm.runInContext(extractFunction(name), context));

// ── _mumRequire: signed out entirely -> gate raised immediately, not just a toast
currentUser = null;
gateCalls.length = 0;
const deniedNoUser = context._mumRequire('payment.create');
assert.strictEqual(deniedNoUser, false, 'action denied with no session');
assert.strictEqual(gateCalls.length, 1, '_mumRequire raises the Sign In gate immediately when there is no session');
assert.strictEqual(gateCalls[0].reason, 'expired', 'gate is raised with the expiry reason so the message is accurate');

// ── _mumRequire: signed in but insufficient role -> toast-only denial, no gate
// (re-showing Sign In would not help an under-privileged but valid session)
currentUser = { userId: 'u1', role: 'Collector' };
gateCalls.length = 0;
const deniedWrongRole = context._mumRequire('data.export');
assert.strictEqual(deniedWrongRole, false, 'action denied for insufficient role');
assert.strictEqual(gateCalls.length, 0, 'a valid-but-insufficient-role session must NOT raise the Sign In gate');

// ── _mumRequire: permitted action passes through untouched
currentUser = { userId: 'u1', role: 'Collector' };
gateCalls.length = 0;
assert.strictEqual(context._mumRequire('payment.create'), true, 'permitted action still succeeds');
assert.strictEqual(gateCalls.length, 0, 'no gate on a permitted action');

// ── Watchdog: edge-triggered on the signed-in -> signed-out transition only
currentUser = { userId: 'u1', role: 'Admin' };
gateCalls.length = 0;
context._mumBindSessionLifecycle();
assert.ok(listeners.appStateChange && listeners.appStateChange.length, 'appStateChange listener registered (catches app resume from background)');
assert.ok(listeners.focus && listeners.focus.length, 'window focus listener registered');
assert.ok(timers.some(t => t[0] === 30000), 'a periodic watchdog timer is registered for the idle-in-foreground case');

context._mumSessionWatchdogCheck(); // still signed in -> no gate
assert.strictEqual(gateCalls.length, 0, 'no gate while the session is still valid');

currentUser = null; // session just expired
context._mumSessionWatchdogCheck();
assert.strictEqual(gateCalls.length, 1, 'the watchdog raises the gate exactly on the signed-in -> signed-out transition');
assert.strictEqual(gateCalls[0].reason, 'expired');

context._mumSessionWatchdogCheck(); // still signed out on the next tick -> must not spam the gate repeatedly
assert.strictEqual(gateCalls.length, 1, 'the watchdog does not re-fire every tick once already surfaced (edge-triggered, not level-triggered)');

// ── A fresh install / first launch (never signed in) must never falsely show "session expired"
currentUser = null;
gateCalls.length = 0;
context._mumSessionLifecycleBound = false; // re-bind as a fresh boot would
delete require.cache; // no-op, just documents this is a clean re-bind
context._mumBindSessionLifecycle();
context._mumSessionWatchdogCheck();
assert.strictEqual(gateCalls.length, 0, 'first launch with no prior session never fires a false "expired" watchdog gate');

// appStateChange only re-checks when the app actually became active
gateCalls.length = 0;
currentUser = { userId: 'u1', role: 'Admin' };
context._mumSessionLifecycleBound = false; // re-bind fresh, now starting from a signed-in state
context._mumBindSessionLifecycle();
currentUser = null;
listeners.appStateChange.forEach(fn => fn({ isActive: false }));
assert.strictEqual(gateCalls.length, 0, 'backgrounding the app must not itself trigger the expiry gate');
listeners.appStateChange.forEach(fn => fn({ isActive: true }));
assert.strictEqual(gateCalls.length, 1, 'resuming the app from background immediately re-checks and surfaces expiry');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'no-session-raises-gate-immediately',
    'insufficient-role-is-toast-only-no-gate',
    'permitted-action-unaffected',
    'lifecycle-listeners-registered',
    'watchdog-edge-triggered-not-repeated',
    'fresh-install-never-false-positive',
    'resume-from-background-rechecks-immediately',
  ],
}, null, 2));
