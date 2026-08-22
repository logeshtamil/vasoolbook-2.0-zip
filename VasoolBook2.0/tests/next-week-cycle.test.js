'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
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

const areas = [
  { areaId: '1000', name: 'North Main', day: 'Sunday' },
  { areaId: '1001', name: 'South Main', day: 'Monday' },
  { areaId: '101', name: 'Central', areaType: 'sub', parentAreaId: '1000', day: '' },
  { areaId: '102', name: 'Central', areaType: 'sub', parentAreaId: '1001', day: 'Wednesday' },
  { areaId: '103', name: 'No Schedule', areaType: 'sub', parentAreaId: '', day: '' }
];

function areaFor(entity) {
  const id = String((entity && entity.areaId) || '');
  if (id) return areas.find(area => area.areaId === id) || null;
  const name = String((entity && entity.area) || '').toLowerCase();
  return areas.find(area => area.name.toLowerCase() === name) || null;
}

function areaDay(area) {
  if (!area) return '';
  if (area.areaType === 'sub') {
    if (area.day) return area.day;
    const parent = areas.find(item => item.areaId === area.parentAreaId);
    return parent ? parent.day || '' : '';
  }
  return area.day || '';
}

const context = {
  Date,
  console,
  _entityAreaObj: areaFor,
  _getAreaDay: areaDay,
  todayStr: () => '2026-07-29'
};
vm.createContext(context);
[
  '_localCalendarParts',
  '_localCalendarString',
  '_isoDate',
  '_dateOnly',
  '_borrowerAreaDay',
  '_borrowerOwnCollectionCycleStart',
  '_borrowerNextWeekReopenDate',
  '_borrowerNextWeekMatchesOwnArea',
  '_borrowerNextWeekAnchor',
  '_borrowerConfiguredAppointmentDate',
  '_borrowerEffectiveWaitingDate'
].forEach(name => vm.runInContext(extractFunction(name), context));

const sundayBorrower = { id: 'sun', areaId: '1000' };
const inheritedSundayBorrower = { id: 'sub-sun', areaId: '101' };
const wednesdayBorrower = { id: 'sub-wed', areaId: '102' };

assert.equal(context._borrowerNextWeekReopenDate(sundayBorrower, '2026-07-26'), '2026-08-02');
assert.equal(context._borrowerNextWeekReopenDate(sundayBorrower, '2026-07-29'), '2026-08-02');
assert.equal(context._borrowerNextWeekReopenDate(sundayBorrower, '2026-08-01'), '2026-08-02');
assert.equal(context._borrowerNextWeekReopenDate(sundayBorrower, '2026-08-02'), '2026-08-09');
assert.equal(context._borrowerNextWeekReopenDate(inheritedSundayBorrower, '2026-07-29'), '2026-08-02');
assert.equal(context._borrowerNextWeekReopenDate(wednesdayBorrower, '2026-07-29'), '2026-08-05');
assert.equal(context._borrowerNextWeekReopenDate({ areaId: '103' }, '2026-07-29'), '');

assert.equal(context._borrowerOwnCollectionCycleStart(sundayBorrower, '2026-07-29'), '2026-07-26');
assert.equal(context._borrowerNextWeekMatchesOwnArea(sundayBorrower, '2026-08-02'), true);
assert.equal(context._borrowerNextWeekMatchesOwnArea(sundayBorrower, '2026-08-03'), false);

const legacyWednesdayClick = {
  areaId: '1000',
  monthlyCycleStatus: 'next_week',
  _nextWeekAnchorDate: '2026-07-29',
  nextDueDate: '2026-08-09'
};
assert.equal(
  context._borrowerEffectiveWaitingDate(legacyWednesdayClick, '2026-07-30'),
  '2026-08-02',
  'legacy click-date anchor is repaired to the borrower cycle'
);
assert.ok(
  context._borrowerEffectiveWaitingDate(legacyWednesdayClick, '2026-07-30') > '2026-07-30',
  'borrower cannot reopen before the exact cycle date'
);
assert.ok(
  context._borrowerEffectiveWaitingDate(legacyWednesdayClick, '2026-08-02') <= '2026-08-02',
  'borrower becomes eligible on the exact cycle date'
);

const monthlyWaitingBorrower = {
  id: 'monthly-wait', areaId: '1001', monthlyCycleStatus: 'next_month',
  nextCollectionDate: '2026-08-29', nextDueDate: '2026-08-29'
};
assert.equal(
  context._borrowerEffectiveWaitingDate(monthlyWaitingBorrower, '2026-08-01'),
  '2026-08-29',
  'monthly next-week status uses its saved next monthly collection date'
);

const appointmentWaitingBorrower = {
  id: 'appointment-wait', areaId: '1000', monthlyCycleStatus: 'next_week',
  _nextWeekCycleStartDate: '2026-07-26', appointmentDate: '2026-08-04',
  nextCollectionDate: '2026-08-02'
};
assert.equal(
  context._borrowerEffectiveWaitingDate(appointmentWaitingBorrower, '2026-07-30'),
  '2026-08-04',
  'appointment date takes precedence over the normal own-area collection date'
);

const originalTimezone = process.env.TZ;
for (const timezone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland']) {
  process.env.TZ = timezone;
  assert.equal(
    context._borrowerNextWeekReopenDate(sundayBorrower, '2026-03-11'),
    '2026-03-15',
    `cycle remains date-only in ${timezone}`
  );
}
process.env.TZ = originalTimezone;

assert.match(source, /var allClosed=all\.filter[\s\S]*?_closedBucketIds[\s\S]*?var allSchedule=all\.filter[\s\S]*?_scheduleBucketIds[\s\S]*?var allActive=all\.filter/);
assert.match(source, /_nextWeekCycleStartDate=cycleStart/);
assert.match(source, /monthlyCycleStatus=appointmentWins\?'appointment':'next_month'/);
assert.match(source, /waitingStatus=b\.monthlyCycleStatus==='next_week'\|\|b\.monthlyCycleStatus==='next_month'\|\|b\.monthlyCycleStatus==='appointment'/);
assert.doesNotMatch(source, /_borrowerNextAreaCollectionDate\(b,\s*ref,\s*7\)/);

const clickContext = {
  borrowers: [{ id: 'weekly-click', areaId: '1000', name: 'Weekly', area: 'North Main', isInterest: false }],
  _apptBid: 'weekly-click',
  todayStr: () => '2026-07-29',
  _isRegularMonthlyLoan: () => false,
  _isMonthlyInterestDueLoan: () => false,
  _borrowerConfiguredAppointmentDate: () => '',
  _borrowerOwnCollectionCycleStart: () => '2026-07-26',
  _borrowerNextWeekReopenDate: () => '2026-08-02',
  _borrowerCycleStartDate: () => '2026-07-26',
  _nextCycleDateAfter: () => '2026-08-29',
  _dateOnly: value => new Date(value + 'T12:00:00'),
  fmtDateWithWeekday: () => 'Sun, 02 Aug 2026',
  isBorrowerMonthlyType: () => false,
  _touchRecord: row => { row.version = 2; },
  saveState: () => { clickContext.saved += 1; },
  saveStateFast: () => { clickContext.saved += 1; },
  renderBorrowers: () => { clickContext.rendered += 1; },
  closeAppointmentPopup: () => { clickContext.closedPopup += 1; },
  showToast: message => { clickContext.toast = message; },
  saved: 0, rendered: 0, closedPopup: 0, toast: '',
  _apptNextWeekBusy: false,
  Date, String, Number, Object, Array, Math, console, setTimeout, clearTimeout
};
vm.createContext(clickContext);
['_apptOptimisticRemoveCard', 'apptNextWeek', '_apptNextWeekImpl'].forEach(name => vm.runInContext(extractFunction(name), clickContext));
clickContext.apptNextWeek();
assert.equal(clickContext.borrowers[0].ignored, true, 'Next Week click immediately enters the Closed waiting state');
assert.equal(clickContext.borrowers[0].monthlyCycleStatus, 'next_week', 'Next Week click persists the waiting status');
assert.equal(clickContext.borrowers[0].nextCollectionDate, '2026-08-02', 'Next Week click persists the borrower own-cycle reopen date');
assert.equal(clickContext.saved, 1, 'Next Week click saves exactly once (fast-path save)');
assert.equal(clickContext.closedPopup, 1, 'Next Week popup closes immediately (before the deferred refresh, for instant responsiveness)');

// The full-list refresh is now deferred one tick past the immediate
// close/save/toast feedback (see apptNextWeek's own comment) — it still
// happens, just not synchronously, so it can never block the button
// responding right away. Wait a tick before checking it landed.
setTimeout(function () {
  assert.equal(clickContext.rendered, 1, 'Next Week click still refreshes exactly once, just deferred past the immediate popup-close/toast');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'sunday-click-on-cycle-day',
      'sunday-midweek-click',
      'no-two-week-skip',
      'next-cycle-boundary',
      'sub-area-parent-inheritance',
      'area-id-isolation',
      'missing-area-day-blocked',
      'legacy-anchor-repair',
      'monthly-saved-cycle-reopen',
      'appointment-date-precedence',
      'early-reopen-blocked',
      'deferred-refresh-does-not-block-immediate-feedback',
      'exact-date-reopen',
      'timezone-date-only',
      'single-tab-precedence',
      'button-first-click-save'
    ]
  }, null, 2));
}, 20);
