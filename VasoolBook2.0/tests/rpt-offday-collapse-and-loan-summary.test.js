'use strict';

// Verifies the second round of Reports-page changes to the OffDay
// Collections and Loans card:
//   1. Collapsed by default — the whole body (filters+summary+list) is one
//      collapsible unit, hidden until the header is tapped.
//   2. A new "Collection & Loan Summary" table is always visible, even while
//      the rest of the card is collapsed, computed from the same From/To/
//      Area filters: Collection = all valid Collection Entries in range,
//      Total Loan Issued = all loans issued (by loandate) in range,
//      Net = Collection − Loan Issued.
//   3. Renamed from "Off-Day Collection" to "OffDay Collections and Loans"
//      on every user-visible surface (header, share text, PDF, share modal).

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

// ── 1. Collapsed by default: the whole body is ONE card-b wrapper, hidden
//      by default, and the entries list itself no longer carries its own
//      separate card-b (so toggleRptSection controls the entire section).
{
  const cardStart = source.indexOf('id="rpt-offday-card"');
  const cardHtml = source.slice(cardStart, cardStart + 3200);
  assert.match(cardHtml, /class="card-b" style="display:none;padding:0" id="rpt-offday-body"/, 'the whole off-day card body starts collapsed (display:none) as a single unit');
  assert.ok(!/class="card-b"[^>]*id="rpt-offday-list"/.test(cardHtml), 'the entries list is no longer its own separate collapsible unit');
  assert.match(cardHtml, /onclick="toggleRptSection\('rpt-offday-card'\)"/, 'the header still toggles the same card via the existing toggleRptSection mechanism');
}

// ── 2. The Collection & Loan Summary element lives OUTSIDE (before) the
//      collapsible body — i.e. it renders even while collapsed.
{
  const cardStart = source.indexOf('id="rpt-offday-card"');
  const summaryPos = source.indexOf('id="rpt-offday-cl-summary"', cardStart);
  const bodyPos = source.indexOf('id="rpt-offday-body"', cardStart);
  assert.ok(summaryPos > 0 && bodyPos > 0 && summaryPos < bodyPos, 'the always-visible Collection & Loan Summary sits before (outside) the collapsible body in the DOM');
}

// ── 3. Renamed everywhere on user-visible surfaces.
assert.ok(source.includes('🕓 OffDay Collections and Loans<span class="rpt-section-icon"'), 'card header renamed');
assert.ok(!/>Off-Day Collection</.test(source) && !source.includes("'Off-Day Collection'") && !source.includes('"Off-Day Collection"'), 'no remaining user-visible "Off-Day Collection" label (old name)');
assert.ok(source.includes("_triggerTextShare(text, 'OffDay Collections and Loans')"), 'text share label renamed');
assert.ok(source.includes("'📋 OffDay Collections and Loans Report'"), 'shared text report title renamed');
assert.ok(source.includes("_rptSharePdfFile(blob,fn,'OffDay Collections and Loans Report')"), 'PDF share title renamed');
assert.ok(source.includes('<div class="rpt-pdf-title">OffDay Collections and Loans Report</div>'), 'PDF document title renamed');
assert.ok(source.includes("titleEl.textContent='Share OffDay Collections and Loans'"), 'share modal title renamed');

// ── 4. Behavioral: _collectionAndLoanSummary computes Collection, Loan
//      Issued, and Net correctly from saved entryLog/borrowers data, scoped
//      by the same date-range + area filters as the rest of the card.
{
  const context = {
    Object, Array, String, Number, Math,
    entryLog: [
      { date: '2026-08-01', today: 500, area: 'North' },
      { date: '2026-08-05', today: 300, area: 'North' },
      { date: '2026-08-10', today: 200, area: 'South' }, // outside range or area, per sub-tests below
      { date: '2026-07-20', today: 999, area: 'North' }, // outside date range
    ],
    borrowers: [
      { loandate: '2026-08-03', loan: 10000, area: 'North' },
      { loandate: '2026-08-20', loan: 5000, area: 'North' },  // outside date range
      { loandate: '2026-08-04', loan: 2000, area: 'South' },  // outside area
    ],
    _areaMatchesValue: (x, value) => x.area === value,
    _areaIsUnderMain: () => false,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('_collectionAndLoanSummary'), context);

  const result = context._collectionAndLoanSummary('2026-08-01', '2026-08-09', 'North', 'All');
  assert.strictEqual(result.collection, 800, 'Collection = sum of valid entries in range/area (500+300), excluding out-of-range and out-of-area entries: ' + result.collection);
  assert.strictEqual(result.collectionCount, 2);
  assert.strictEqual(result.loanIssued, 10000, 'Loan Issued = sum of loans with loandate in range/area, excluding the out-of-range and out-of-area loans: ' + result.loanIssued);
  assert.strictEqual(result.loanCount, 1);
  assert.strictEqual(result.net, -9200, 'Net = Collection - Loan Issued (800 - 10000)');

  // No area filter ("All") includes every area.
  const allAreas = context._collectionAndLoanSummary('2026-08-01', '2026-08-09', 'All', 'All');
  assert.strictEqual(allAreas.collection, 800, 'still just the in-range entries (the South entry on 08-10 is outside the date range too)');
  assert.strictEqual(allAreas.loanIssued, 12000, 'both in-range loans (North + South) counted with no area filter: ' + allAreas.loanIssued);
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'offday-collapsed-by-default-single-unit',
    'entries-list-no-longer-separately-collapsible',
    'header-still-uses-existing-toggle-mechanism',
    'summary-renders-outside-collapsible-body',
    'header-renamed',
    'no-remaining-old-name-labels',
    'text-share-label-renamed',
    'shared-text-title-renamed',
    'pdf-share-title-renamed',
    'pdf-document-title-renamed',
    'share-modal-title-renamed',
    'collection-loan-summary-collection-calculation',
    'collection-loan-summary-loan-issued-calculation',
    'collection-loan-summary-net-calculation',
    'collection-loan-summary-respects-area-scope',
    'collection-loan-summary-all-areas-when-unfiltered',
  ],
}, null, 2));
