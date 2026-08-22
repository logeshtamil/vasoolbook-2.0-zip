'use strict';

// Verifies the Reminders page UI/workflow update:
//   1. Reschedule (🕒) now opens a native Date Picker immediately
//      (input[type=date].showPicker(), with a focus+click fallback) instead
//      of the old two-prompt() flow — selecting a date saves/updates the
//      reminder and refreshes the card immediately, preserving the
//      reminder's existing time-of-day and all other fields.
//   2. The Edit (✏️) button/icon and its editReminderNote() function are
//      removed completely — no replacement edit option.
//   3. A new Call (📞) button dials the borrower's saved phone number via
//      the app's existing native-dialer path, preferring the LIVE borrower
//      record's phone over the reminder's own snapshot, and shows a small
//      non-blocking toast (never throws) when no valid phone exists.
//   4. Done, Reschedule, and Delete remain wired to their existing,
//      unmodified functions (dismissReminder / editReminderDateTime /
//      deleteReminder).

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

// ── 1. Source-level: card button row is exactly Done, Reschedule, Call, Delete. ──
const cardMarker = "onclick=\"dismissReminder(";
const cardStart = source.indexOf(cardMarker);
assert.ok(cardStart >= 0, 'reminder card action row exists');
const cardButtonsHtml = source.slice(cardStart - 20, source.indexOf("'</div></div>'", cardStart) + 20);
assert.match(cardButtonsHtml, /dismissReminder\(/, 'Done button unchanged');
assert.match(cardButtonsHtml, /editReminderDateTime\(/, 'Reschedule button unchanged');
assert.match(cardButtonsHtml, /callReminderBorrower\(/, 'new Call button is wired');
assert.match(cardButtonsHtml, /deleteReminder\(/, 'Delete button unchanged');
assert.doesNotMatch(cardButtonsHtml, /editReminderNote\(/, 'Edit note button is gone');
assert.doesNotMatch(cardButtonsHtml, /✏️/, 'no Edit pencil icon remains anywhere in the action row');
assert.match(cardButtonsHtml, /📞/, 'Call button uses the phone emoji');
// Order: Done, Reschedule, Call, Delete.
const iDone = cardButtonsHtml.indexOf('dismissReminder(');
const iResched = cardButtonsHtml.indexOf('editReminderDateTime(');
const iCall = cardButtonsHtml.indexOf('callReminderBorrower(');
const iDelete = cardButtonsHtml.indexOf('deleteReminder(');
assert.ok(iDone < iResched && iResched < iCall && iCall < iDelete, 'button order is Done, Reschedule, Call, Delete');

assert.doesNotMatch(source, /function editReminderNote\(/, 'editReminderNote function is removed completely, not just detached');

// ── 2. Source-level: Reschedule no longer uses prompt(); uses a real date
//      picker via showPicker() with a fallback. ─────────────────────────────
const rescheduleFn = extractFunction('editReminderDateTime');
assert.doesNotMatch(rescheduleFn, /prompt\(/, 'no more text-prompt dialogs for rescheduling');
assert.match(rescheduleFn, /showPicker/, 'opens the native date picker via showPicker()');
assert.match(rescheduleFn, /input\.focus\(\)/, 'falls back to focus (older WebViews) if showPicker is unavailable');

const applyFn = extractFunction('_applyRescheduledReminderDate');
assert.match(applyFn, /saveReminders\(\)/, 'persists the rescheduled date');
assert.match(applyFn, /renderReminderList\(\)/, 'refreshes the reminder card list immediately');

// ── 3. Source-level: Call reuses the existing native-dialer path, never a
//      new/duplicate dialing mechanism. ─────────────────────────────────────
const callFn = extractFunction('callReminderBorrower');
assert.match(callFn, /openNativeDialer\(phone,false\)/, 'reuses the existing shared dialer function, not a new tel: implementation');
assert.match(callFn, /No phone number available/, 'shows a clear non-blocking message when no phone is available');

// ── 4. Behavioral: reschedule flow updates the correct reminder, preserves
//      time-of-day, and never touches unrelated fields. ─────────────────────
function buildContext() {
  const state = { toasts: [], rendered: 0, saved: 0 };
  const elements = {};
  class FakeInput {
    constructor() { this.value = ''; this._listeners = {}; this.showPicker = undefined; this.style = {}; }
    addEventListener(evt, fn) { this._listeners[evt] = fn; }
    focus() { state.focused = true; }
    click() { state.clicked = true; }
  }
  const dateInput = new FakeInput();
  const context = {
    Object, Array, String, Number, Boolean, Date, JSON, Math, isNaN,
    reminders: [],
    borrowers: [],
    showToast: msg => state.toasts.push(msg),
    saveReminders: () => { state.saved += 1; },
    renderReminderList: () => { state.rendered += 1; },
    openNativeDialer: (phone, direct) => { state.dialed = { phone, direct }; return true; },
    _isoDate: d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
    fmtDateWithWeekday: d => d.toDateString(),
    fmtTime: d => d.toTimeString().slice(0, 5),
    document: {
      getElementById: id => (id === 'reminder-reschedule-date-input' ? (elements.created ? dateInput : null) : null),
      createElement: () => dateInput,
      body: { appendChild: () => { elements.created = true; } },
      documentElement: { appendChild: () => { elements.created = true; } },
    },
    _state: state,
    _dateInput: dateInput,
  };
  vm.createContext(context);
  ['_ensureReminderDateInput', 'editReminderDateTime', '_applyRescheduledReminderDate', 'callReminderBorrower']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

{
  const ctx = buildContext();
  ctx.reminders = [
    { id: 'R1', bid: 'B1', name: 'Ravi', area: 'Zone A', phone: '9000000001', datetime: '2026-09-01T14:30', note: 'call back', balance: 500 },
    { id: 'R2', bid: 'B2', name: 'Kamala', area: 'Zone B', phone: '9000000002', datetime: '2026-09-02T09:00' },
  ];

  // Tap Reschedule on R1 — opens the picker with R1's current date preloaded.
  ctx.editReminderDateTime('R1');
  assert.strictEqual(ctx._dateInput.value, '2026-09-01', 'the date input is preloaded with the reminder\'s current date');
  assert.ok(ctx._state.focused || ctx._state.clicked, 'the picker is opened (focus/click fallback fired since showPicker is unavailable in this fake DOM)');

  // User picks a new date -> the change listener fires.
  ctx._dateInput.value = '2026-09-15';
  ctx._dateInput._listeners.change();

  const updated = ctx.reminders.find(r => r.id === 'R1');
  assert.strictEqual(updated.datetime, '2026-09-15T14:30', 'date changes to the picked value; original time (14:30) is preserved exactly');
  assert.strictEqual(ctx.reminders.find(r => r.id === 'R2').datetime, '2026-09-02T09:00', 'the OTHER reminder (R2) is completely untouched');
  assert.strictEqual(updated.note, 'call back', 'unrelated reminder fields (note) are preserved');
  assert.strictEqual(updated.balance, 500, 'unrelated reminder fields (balance) are preserved');
  assert.strictEqual(updated.phone, '9000000001', 'unrelated reminder fields (phone) are preserved');
  assert.strictEqual(ctx._state.saved, 1, 'the rescheduled date is persisted');
  assert.strictEqual(ctx._state.rendered, 1, 'the reminder card list is refreshed immediately');
}

{
  // Call: prefers the LIVE borrower phone over the reminder's own snapshot.
  const ctx = buildContext();
  ctx.reminders = [{ id: 'R1', bid: 'B1', name: 'Ravi', phone: '9000000001-OLD' }];
  ctx.borrowers = [{ id: 'B1', name: 'Ravi', phone: '9000000009-LIVE' }];
  ctx.callReminderBorrower('R1');
  assert.deepStrictEqual(ctx._state.dialed, { phone: '9000000009-LIVE', direct: false }, 'dials the current/live borrower phone number, not a stale reminder-time snapshot');
}

{
  // Call: falls back to the reminder's own phone snapshot if the borrower record can't be found.
  const ctx = buildContext();
  ctx.reminders = [{ id: 'R1', bid: 'B-GONE', name: 'Ravi', phone: '9000000001' }];
  ctx.borrowers = [];
  ctx.callReminderBorrower('R1');
  assert.deepStrictEqual(ctx._state.dialed, { phone: '9000000001', direct: false }, 'falls back to the phone saved on the reminder itself when the borrower record is missing');
}

{
  // Call: no phone anywhere -> non-blocking toast, never throws, never dials.
  const ctx = buildContext();
  ctx.reminders = [{ id: 'R1', bid: 'B1', name: 'Ravi', phone: '' }];
  ctx.borrowers = [{ id: 'B1', name: 'Ravi', phone: '' }];
  assert.doesNotThrow(() => ctx.callReminderBorrower('R1'), 'never throws/crashes when no valid phone number exists');
  assert.strictEqual(ctx._state.dialed, undefined, 'never attempts to dial with no phone number');
  assert.ok(ctx._state.toasts.some(t => /No phone number/i.test(t)), 'shows a small non-blocking notification instead');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'card-done-button-unchanged',
    'card-reschedule-button-unchanged',
    'card-call-button-wired',
    'card-delete-button-unchanged',
    'card-edit-button-removed',
    'card-no-edit-icon-remains',
    'card-call-icon-present',
    'card-button-order-done-reschedule-call-delete',
    'edit-reminder-note-function-removed',
    'reschedule-no-longer-uses-prompt',
    'reschedule-uses-native-date-picker',
    'reschedule-has-focus-fallback',
    'apply-reschedule-persists',
    'apply-reschedule-refreshes-list',
    'call-reuses-existing-dialer',
    'call-shows-clear-no-phone-message',
    'reschedule-preloads-current-date',
    'reschedule-opens-picker',
    'reschedule-updates-date-preserves-time',
    'reschedule-does-not-touch-other-reminders',
    'reschedule-preserves-unrelated-fields',
    'reschedule-persists-once',
    'reschedule-refreshes-once',
    'call-prefers-live-borrower-phone',
    'call-falls-back-to-reminder-phone-snapshot',
    'call-never-throws-with-no-phone',
    'call-never-dials-with-no-phone',
    'call-shows-non-blocking-toast',
  ],
}, null, 2));
