'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = html.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = html.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = html.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

const entries = [
  { id: 'same-id', bid: 'loan-other', today: 999, date: '2026-08-01' },
  { id: 'same-id', bid: 'loan-1', today: 250, date: '2026-08-02' },
  { bid: 'loan-1', today: 300, date: '2026-08-03' }
];
const resolverContext = { entryLog: entries, parseInt, isFinite, String };
vm.createContext(resolverContext);
vm.runInContext(functionSource('_resolveInfoPaymentDelete'), resolverContext);
assert.strictEqual(resolverContext._resolveInfoPaymentDelete('loan-1', 'same-id', 1).index, 1, 'selected borrower/index wins over a duplicate ID on another loan');
assert.strictEqual(resolverContext._resolveInfoPaymentDelete('loan-1', '', 2).index, 2, 'legacy payment without ID remains selectable by exact rendered index');
assert.match(resolverContext._resolveInfoPaymentDelete('loan-1', 'missing', -1).error, /not found/i);

const events = [];
const sandbox = {
  console, JSON, String, Number, Date, Math, parseInt, parseFloat, isFinite, Error, Promise,
  entryLog: entries.map(row => ({ ...row })),
  borrowers: [
    { id: 'loan-1', loan: 1000, prev: 450, originalOpeningPaid: 100, openingPaidAmount: 100, openingPrev: 100 },
    { id: 'loan-other', loan: 2000, prev: 999 }
  ],
  _vbTombstones: [],
  _infoSheetBid: 'loan-1',
  _mumRequire: action => { events.push('permission:' + action); return true; },
  confirm: () => true,
  fmt: value => 'Rs.' + Number(value || 0),
  fmtDate: value => value || '',
  showToast: message => events.push('toast:' + message),
  VBProcessing: {
    begin: () => ({ completed: false }),
    complete: (token, status) => { token.completed = true; events.push('processing:' + status); },
    end: () => events.push('processing:end')
  },
  _vbCloneDataState() {
    return JSON.parse(JSON.stringify({ borrowers: sandbox.borrowers, entryLog: sandbox.entryLog, tombstones: sandbox._vbTombstones }));
  },
  _vbRestoreDataState(state) {
    sandbox.borrowers = state.borrowers;
    sandbox.entryLog = state.entryLog;
    sandbox._vbTombstones = state.tombstones;
    events.push('rollback');
  },
  _vbIsOpeningPaidEntry: entry => !!entry.isOpeningPaid,
  _getOpeningPaid: borrower => Number(borrower.originalOpeningPaid || 0),
  _vbRecordTombstone(kind, entry) {
    const row = { kind, key: 'id:' + (entry.id || 'legacy'), entityId: entry.id || 'legacy' };
    sandbox._vbTombstones.push(row);
    events.push('tombstone:' + entry.bid + ':' + entry.today);
    return row;
  },
  _touchInterestLoanRevision: bid => events.push('revision:' + bid),
  recalcInterestLoanFromHistory: bid => events.push('recalc:' + bid),
  syncBorrowerBalanceFromHistory: bid => events.push('balance:' + bid),
  _vbRecoveryKv: state => ({ cm_b: JSON.stringify(state.borrowers), cm_l: JSON.stringify(state.entryLog), cm_tombstones_v1: JSON.stringify(state.tombstones) }),
  _vbIdbSetMany: async kv => { events.push('persist:' + JSON.parse(kv.cm_l).length); return sandbox.persistOk; },
  _vbWriteLocalMirrorAtomic: () => { events.push('mirror'); return true; },
  _refreshAfterLoanAction: bid => events.push('refresh:' + bid),
  _storageAudit: (action, ok) => events.push('audit:' + action + ':' + ok),
  renderBorrowers: () => events.push('renderBorrowers'),
  renderLog: () => events.push('renderLog'),
  openInfoSheet: bid => events.push('info:' + bid),
  persistOk: true
};
vm.createContext(sandbox);
vm.runInContext(functionSource('_resolveInfoPaymentDelete'), sandbox);
vm.runInContext(functionSource('delHistEntry'), sandbox);

(async () => {
  await sandbox.delHistEntry('loan-1', 'same-id', 1);
  assert.strictEqual(sandbox.entryLog.length, 2, 'exactly one payment is removed');
  assert.ok(sandbox.entryLog.some(row => row.bid === 'loan-other' && row.id === 'same-id'), 'same-ID payment owned by another borrower is preserved');
  assert.ok(!sandbox.entryLog.some(row => row.bid === 'loan-1' && row.id === 'same-id'), 'selected payment is removed');
  assert.strictEqual(sandbox.borrowers[0].originalOpeningPaid, 100, 'Opening Paid remains unchanged');
  assert.ok(events.indexOf('persist:2') < events.indexOf('refresh:loan-1'), 'durable persistence finishes before UI refresh');
  assert.ok(events.includes('permission:payment.edit'), 'delete uses the protected payment-edit permission');
  assert.ok(events.includes('processing:success'), 'processing state completes successfully');

  const beforeFailure = JSON.parse(JSON.stringify({ borrowers: sandbox.borrowers, entryLog: sandbox.entryLog }));
  sandbox.persistOk = false;
  const legacyIndex = sandbox.entryLog.findIndex(row => row.bid === 'loan-1' && !row.id);
  await sandbox.delHistEntry('loan-1', '', legacyIndex);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.entryLog)), beforeFailure.entryLog, 'failed IndexedDB commit rolls deleted payment back');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.borrowers)), beforeFailure.borrowers, 'failed commit rolls recalculated borrower state back');
  assert.ok(events.includes('rollback'), 'rollback path ran');
  assert.ok(events.includes('processing:error'), 'processing state reports failure and releases');

  const deleteSource = functionSource('delHistEntry');
  assert.ok(deleteSource.includes('entryLog.splice(selected.index,1)'), 'handler removes only the selected row');
  assert.ok(!deleteSource.includes('entryLog=entryLog.filter'), 'handler never removes every duplicate ID');
  assert.ok(deleteSource.indexOf('await _vbIdbSetMany(kv)') < deleteSource.indexOf('_refreshAfterLoanAction(bid,true)'), 'commit precedes refresh');
  assert.ok(functionSource('_vbRecordTombstone').includes("var now=new Date().toISOString()"), 'tombstone timestamp is initialized locally');
  assert.ok(html.includes("delHistEntry(decodeURIComponent("), 'Info Delete button sends borrower, payment, and rendered index identity');
  console.log(JSON.stringify({ status: 'PASS', checks: ['exact selected row', 'cross-borrower duplicate preserved', 'legacy ID-less selection', 'Opening Paid protected', 'tombstone timestamp', 'durable commit before refresh', 'rollback', 'permission', 'processing cleanup'] }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
