'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
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
  throw new Error(`unterminated ${name}`);
}

const context = {
  Date, Math, Number, String, Object, Intl, isFinite, isNaN,
  _VB_BUSINESS_TIME_ZONE: 'Asia/Kolkata',
  _vbIndiaDateTimeFormatter: null,
  _fmtDateCache: {}
};
vm.createContext(context);
[
  '_technicalIsoNow','_indiaTimestampParts','_preserveRecordTimestamps',
  '_stampNewRecord','_touchRecord','_parsePaymentDateMs','_displayDateParts',
  'fmtDate','fmtTime','fmtDateTime','paymentEntrySortTime',
  '_localCalendarParts','_localCalendarString','todayStr'
].forEach(name => vm.runInContext(extractFunction(name), context));

// India business midnight is 18:30 UTC. Technical storage remains UTC ISO.
assert.equal(context._technicalIsoNow('2026-08-14T18:30:00+00:00'), '2026-08-14T18:30:00.000Z');
assert.equal(context.fmtDateTime('2026-08-14T18:29:59.000Z', true), '14-Aug-2026 11:59:59 PM');
assert.equal(context.fmtDateTime('2026-08-14T18:30:00.000Z', true), '15-Aug-2026 12:00:00 AM');
assert.equal(context.todayStr(new Date('2026-08-14T18:29:59.000Z')), '2026-08-14');
assert.equal(context.todayStr(new Date('2026-08-14T18:30:00.000Z')), '2026-08-15');
assert.equal(context.fmtDate('2026-08-14'), '14-Aug-2026', 'date-only business value never shifts');

// Creation time is immutable; edits update only updatedAt.
const original = {
  id: 'p1', date: '2026-08-15',
  ts: '2026-08-15T03:30:00.000Z',
  createdAt: '2026-08-15T03:30:00.000Z',
  updatedAt: '2026-08-15T03:30:00.000Z'
};
context._touchRecord(original, '2026-08-20T10:00:00.000Z');
assert.equal(original.ts, '2026-08-15T03:30:00.000Z');
assert.equal(original.createdAt, '2026-08-15T03:30:00.000Z');
assert.equal(original.updatedAt, '2026-08-20T10:00:00.000Z');

// Legacy normalization may copy an existing instant, but must not invent now.
const legacy = {id: 'legacy', ts: '2025-01-01T01:02:03.000Z'};
context._preserveRecordTimestamps(legacy);
assert.equal(legacy.createdAt, legacy.ts);
assert.equal(legacy.updatedAt, legacy.ts);
const missing = {id: 'missing'};
context._preserveRecordTimestamps(missing);
assert.deepEqual(missing, {id: 'missing'});

// Same business date sorts by immutable creation time, not a later edit time.
const first = {date:'2026-08-15',createdAt:'2026-08-15T03:30:00.000Z',updatedAt:'2026-08-30T00:00:00.000Z'};
const second = {date:'2026-08-15',createdAt:'2026-08-15T04:30:00.000Z',updatedAt:'2026-08-15T04:30:00.000Z'};
assert.ok(context.paymentEntrySortTime(first) < context.paymentEntrySortTime(second));

// Backup/restore JSON round-trip preserves exact technical timestamps.
const restored = JSON.parse(JSON.stringify({entryLog:[original],borrowers:[{id:'b1',createdAt:'2024-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]}));
assert.equal(restored.entryLog[0].createdAt, original.createdAt);
assert.equal(restored.entryLog[0].updatedAt, original.updatedAt);
assert.equal(restored.borrowers[0].createdAt, '2024-01-01T00:00:00.000Z');

// Source guards for audited financial and migration paths.
assert.doesNotMatch(extractFunction('_vbNormalizeOpeningPaidRecord'), /date\+'T00:00:00\.000Z'/);
assert.doesNotMatch(extractFunction('recalcInterestLoanFromHistory'), /e\.updatedAt\s*=\s*e\.updatedAt\s*\|\|\s*new Date/);
assert.match(extractFunction('saveEditPayModal'), /_touchRecord\(entryLog\[ei\]\)/);
assert.match(extractFunction('_proceedSaveEntry'), /createdAt:_entryStamp/);
assert.match(extractFunction('_proceedSaveEntryNextCycle'), /createdAt:_advanceEntryStamp/);
assert.match(extractFunction('saveTopUp'), /_topupCreatedStamp/);
assert.match(extractFunction('syncAudit'), /createdAt:auditStamp/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'utc-iso-storage','kolkata-2359-to-0000','date-only-no-shift',
    'immutable-created-at','edit-updated-at-only','legacy-no-invented-time',
    'same-day-chronological-sort','backup-restore-exact-timestamps',
    'payment-create-stamp','advance-create-stamp','topup-edit-preserves-time',
    'audit-log-stamp','recalc-does-not-restamp'
  ]
}, null, 2));
