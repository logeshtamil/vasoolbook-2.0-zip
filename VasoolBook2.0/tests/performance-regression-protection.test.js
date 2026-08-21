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

const historyContext = { entryLog: [] };
vm.createContext(historyContext);
vm.runInContext(extractFunction('_historyIsRecent'), historyContext);
vm.runInContext(extractFunction('_oldHistoryEntries'), historyContext);
historyContext.entryLog = [
  { id: 'old', date: '2026-06-14' },
  { id: 'edge', date: '2026-06-15' },
  { id: 'new', date: '2026-08-15' },
  { id: 'undated', date: '' }
];
assert.deepEqual(
  JSON.parse(JSON.stringify(historyContext._oldHistoryEntries('2026-06-15').map(row => row.id))),
  ['old'],
  'cached cutoff preserves exact recent/archive boundary'
);

const renderLog = extractFunction('renderLog');
assert.match(renderLog, /!_normalizedQ\|\|_historySearchMatchesNormalized/,
  'empty History search skips expensive field construction');
assert.match(renderLog, /_historyIsRecent\(e,_monthStart\)/,
  'History rows reuse one render cutoff');
assert.match(renderLog, /_oldHistoryEntries\(_monthStart\)/,
  'archive count reuses the same cutoff');

const dateOverlayInit = extractFunction('_vbInitAllDateOverlays');
assert.match(dateOverlayInit, /_vbDateOverlayInputs\.forEach/,
  'date synchronization visits only registered date inputs');
assert.doesNotMatch(dateOverlayInit,
  /setInterval\([\s\S]*document\.querySelectorAll\('input\[type="date"\]'\)/,
  'date synchronization does not rescan the whole document');
assert.match(extractFunction('_vbInitDateOverlay'), /_vbOverlayRegistered/,
  'date inputs are registered once');

const borrowerScheduler = extractFunction('scheduleBorrowerRender');
assert.match(borrowerScheduler, /cancelAnimationFrame\|\|clearTimeout/,
  'new borrower search input cancels a stale render frame');
assert.match(borrowerScheduler, /_borrowerRenderFrame=/,
  'borrower rendering remains animation-frame batched');

let flushes = 0, snapshots = 0;
const exitContext = {
  _saveTimer: 1,
  _saveForced: true,
  _rawSaveStatePending: true,
  _vbHasPendingExitSave: () => true,
  clearTimeout: () => {},
  _rawSaveStateFlushIfPending: () => { exitContext._rawSaveStatePending = false; flushes += 1; },
  _vbWriteAutoSnapshot: () => { snapshots += 1; },
  _storageAudit: () => {}
};
vm.createContext(exitContext);
vm.runInContext(extractFunction('_vbQuickLocalSaveBeforeExit'), exitContext);
exitContext._vbQuickLocalSaveBeforeExit();
assert.equal(flushes, 1, 'Android exit performs one durable flush');
assert.equal(snapshots, 1, 'Android exit still creates one auto snapshot');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'history-cutoff-reuse',
    'empty-search-fast-path',
    'date-overlay-registered-polling',
    'borrower-stale-frame-cancelled',
    'single-exit-persistence-flush'
  ]
}, null, 2));
