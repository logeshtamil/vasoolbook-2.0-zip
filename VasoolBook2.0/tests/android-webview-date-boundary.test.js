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

let simulatedToday = '2026-08-14';
const calls = {skipped:0,monthly:0,borrowers:0,reminders:0,reports:0};
const context = {
  Date, Math, Number, String, Object, isFinite, isNaN,
  Intl, _VB_BUSINESS_TIME_ZONE: 'Asia/Kolkata', _vbIndiaDateTimeFormatter: null,
  _LIC_TRIAL_DAYS: 14,
  todayStr: () => simulatedToday,
  _areaDayByName: () => 'Sunday',
  autoRestoreSkipped: () => { calls.skipped += 1; },
  _autoRestoreMonthlyInterestLoans: () => { calls.monthly += 1; },
  renderBorrowers: () => { calls.borrowers += 1; },
  renderReminderList: () => { calls.reminders += 1; },
  renderReports: () => { calls.reports += 1; }
};
vm.createContext(context);
[
  '_indiaTimestampParts','_localCalendarParts','_localCalendarString','_dateOnly','_isoDate','_localCalendarOrdinal',
  '_localCalendarAddDays','_daysBetween','_daysDiff','_trialEndDate','_daysInMonth',
  '_cycleMonthDate','_dateDayName','_scheduledDateForAreaPost','_mdcDay',
  '_vbRefreshBusinessDateBoundary'
].forEach(name => vm.runInContext(extractFunction(name), context));

// Local-calendar midnight: no UTC conversion is involved.
assert.equal(context._localCalendarString(new Date('2026-08-14T18:29:59.000Z')), '2026-08-14');
assert.equal(context._localCalendarString(new Date('2026-08-14T18:30:00.000Z')), '2026-08-15');
assert.equal(context._dateOnly('2026-08-15').getHours(), 12, 'business dates use stable local noon');

// Leap day, month length, clamping and year rollover.
assert.equal(context._cycleMonthDate('2026-01-31', 1), '2026-02-28');
assert.equal(context._cycleMonthDate('2028-01-31', 1), '2028-02-29');
assert.equal(context._cycleMonthDate('2026-03-31', 1), '2026-04-30');
assert.equal(context._cycleMonthDate('2026-01-31', 2), '2026-03-31');
assert.equal(context._cycleMonthDate('2026-12-31', 1), '2027-01-31');
assert.equal(context._localCalendarAddDays('2028-02-28', 1), '2028-02-29');
assert.equal(context._localCalendarAddDays('2026-12-31', 1), '2027-01-01');
assert.equal(context._daysBetween('2028-02-28', '2028-03-01'), 2);
assert.equal(context._daysDiff('2026-03-01', '2026-02-28'), -1);
assert.equal(context._trialEndDate('2026-12-31'), '2027-01-14');

// Calendar ordinals are timezone/DST independent, even across DST dates.
assert.equal(context._localCalendarOrdinal('2026-03-08') - context._localCalendarOrdinal('2026-03-07'), 1);
assert.equal(context._localCalendarOrdinal('2026-11-01') - context._localCalendarOrdinal('2026-10-31'), 1);
assert.equal(context._daysBetween('2026-03-07', '2026-03-09'), 2);

// Reports and reminders preserve local calendar dates at rollovers.
assert.equal(context._dateDayName('2026-08-16'), 'Sunday');
assert.equal(context._scheduledDateForAreaPost('AREA-1', '2026-08-31'), '2026-08-30');
assert.equal(context._scheduledDateForAreaPost('AREA-1', '2027-01-01'), '2026-12-27');
assert.equal(context._mdcDay('2028-02-29'), 29);

// Background/resume refresh happens exactly once per new local business date.
context._vbBusinessDateSeen = '2026-08-14';
assert.equal(context._vbRefreshBusinessDateBoundary('same-day'), false);
assert.deepEqual(calls, {skipped:0,monthly:0,borrowers:0,reminders:0,reports:0});
simulatedToday = '2026-08-15';
assert.equal(context._vbRefreshBusinessDateBoundary('resume'), true);
assert.deepEqual(calls, {skipped:1,monthly:1,borrowers:1,reminders:1,reports:1});
assert.equal(context._vbRefreshBusinessDateBoundary('duplicate-resume'), false);
assert.deepEqual(calls, {skipped:1,monthly:1,borrowers:1,reminders:1,reports:1});

assert.equal(context._localCalendarString('2026-02-30'), '', 'invalid business date is rejected');
assert.ok(isNaN(context._dateOnly('2026-02-30').getTime()));

// Guard the audited business-date paths against UTC/bare ISO regression.
assert.doesNotMatch(source, /new Date\((loanDate|loanEnd|today|ref|row\.loanEnd|postDate|dateVal|dateStr|install)\)/);
assert.doesNotMatch(source, /toISOString\(\)\.(?:slice\(0,10\)|split\('T'\)\[0\])/);
assert.match(source, /app\.addListener\('appStateChange'/);
assert.match(source, /visibility-resume/);
assert.match(source, /midnight-timer/);

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    '2359-to-0000','local-noon-parser','28-feb','29-feb','30-day-clamp','31-day-anchor',
    'month-rollover','year-rollover','dst-independent-ordinal','resume-once-per-date',
    'weekly-report-day','reminder-day','invalid-date-rejection','no-bare-iso-business-parse',
    'capacitor-resume','visibility-resume','active-midnight-timer'
  ]
}, null, 2));
