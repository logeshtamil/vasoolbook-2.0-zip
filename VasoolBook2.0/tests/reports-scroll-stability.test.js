'use strict';

const assert = require('assert');
const fs = require('fs');

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
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const scheduler = extractFunction('_scheduleReportInput');
const calc = extractFunction('calcCollReport');

assert.match(source, /function isReportsTypableField\(el\)[\s\S]*#tab-reports/);
assert.match(source, /isHistoryTypableField\(el\)\|\|isReportsTypableField\(el\)/);
assert.match(source, /!isHistoryTypableField\(activeEl\)&&!isReportsTypableField\(activeEl\)/);
assert.match(source, /!isHistoryTypableField\(activeEl\)&&!isReportsTypableField\(activeEl\)\)return;/);
assert.match(source, /#tab-reports\{touch-action:pan-y;overscroll-behavior-y:auto\}/);
assert.match(scheduler, /clearTimeout\(_reportInputTimers\[key\]\)/);
assert.match(scheduler, /requestAnimationFrame/);
assert.match(source, /id="bstat-search"[^>]*oninput="scheduleBorrowerStatsRender\(\)"/);
assert.match(source, /id="rpt-loans-search-input"[^>]*oninput="scheduleRptListFilter\('loans'\)"/);
assert.match(source, /id="rpt-entries-search-input"[^>]*oninput="scheduleRptListFilter\('entries'\)"/);

const reportBoxIds = [
  'cr-finCash','cr-cashOut','cr-ctBank','cr-dfBank','cr-food','cr-fuel','cr-other',
  'cr-nlAmt','cr-misLoan','cr-commR','cr-intLoan','cr-wkColl','cr-intColl','cr-misPay','cr-princ'
];
reportBoxIds.forEach(id => {
  assert.match(source, new RegExp(`id="${id}"[^>]*oninput="scheduleCalcCollReport\\(\\)"`), `${id} uses the nonblocking scheduler`);
});
assert.equal((source.match(/oninput="calcCollReport\(\)"/g) || []).length, 0, 'no synchronous collection-report input handlers remain');
assert.doesNotMatch(calc, /renderReports\s*\(/, 'collection report calculation does not rebuild the Reports page');
assert.match(source, /if\(dEl2 && !dEl2\._crWired\)/, 'collection report date listener is guarded');
assert.match(source, /if\(sel2 && !sel2\._crWired\)/, 'collection report area listener is guarded');

console.log(JSON.stringify({
  status: 'PASS',
  reportBoxes: reportBoxIds.length,
  checks: [
    'reports-excluded-from-body-scroll-lock',
    'reports-touch-blur-unlock',
    'reports-visual-viewport-stability',
    'reports-pan-y-contract',
    'debounced-borrower-statistics',
    'debounced-entry-search',
    'debounced-loan-search',
    'all-collection-report-boxes-scheduled',
    'no-full-report-render-from-box-calculation',
    'duplicate-listener-guards'
  ]
}, null, 2));
