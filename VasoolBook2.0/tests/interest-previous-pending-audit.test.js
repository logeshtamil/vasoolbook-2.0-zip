'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');
const marker = 'function _auditInterestPreviousPending(';
const start = source.indexOf(marker);
assert.ok(start >= 0, 'previous-pending audit exists');
const bodyStart = source.indexOf('{', start);
let depth = 0;
let end = -1;
for (let index = bodyStart; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1;
  if (source[index] === '}' && --depth === 0) { end = index + 1; break; }
}
assert.ok(end > bodyStart, 'previous-pending audit is complete');

const borrowers = [
  { id: 'settled', name: 'Settled', isInterest: true, prevPendingInterest: 900 },
  { id: 'partial', name: 'Partial', isInterest: true, prevPendingInterest: 0 }
];
const entryLog = [{ id: 'legacy-arrear-payment', bid: 'settled', date: '2026-08-01', prevPendingArrearPaid: 200 }];
const borrowerBefore = JSON.stringify(borrowers);
const entriesBefore = JSON.stringify(entryLog);
const context = {
  Date,
  Math,
  borrowers,
  entryLog,
  todayStr: () => '2026-08-09',
  getInterestBreakdown: borrower => ({ pendingInterest: borrower.id === 'partial' ? 250 : 0 }),
  getInterestCycleCalculation: borrower => ({ pendingInterest: borrower.id === 'partial' ? 250 : 0 }),
  window: {},
  _storageAudit: () => {}
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const report = context._auditInterestPreviousPending('test');

assert.strictEqual(report.verifiedPreviousDue, 250);
assert.strictEqual(report.legacyScalarFlags.length, 1);
assert.strictEqual(report.settledCarryFlags.length, 1);
assert.strictEqual(report.unlinkedArrearPayments.length, 1);
assert.strictEqual(JSON.stringify(borrowers), borrowerBefore);
assert.strictEqual(JSON.stringify(entryLog), entriesBefore);

console.log('Interest previous-pending read-only audit tests passed.');
