'use strict';

const assert = require('assert');
const fs = require('fs');
const C = require('../www/js/vasoolbook-sqlite-core.js');

const currentHistory = [
  { id: 'p1', bid: 'l1', today: 1000, updatedAt: '2026-07-22T10:00:00Z' },
  { id: 'p1', bid: 'l1', today: 800, updatedAt: '2026-07-20T10:00:00Z' }
];
const localStorageHistory = [
  { id: 'p1', bid: 'l1', today: 500, updatedAt: '2026-07-19T10:00:00Z' },
  { id: 'p2', bid: 'l1', today: 300, updatedAt: '2026-07-21T10:00:00Z' }
];
const autoBackupHistory = [
  { id: 'p2', bid: 'l1', today: 300, updatedAt: '2026-07-21T10:00:00Z' },
  { id: 'p3', bid: 'l1', today: 400, updatedAt: '2026-07-22T11:00:00Z' }
];

const history = C.mergeRecoveryArrays('entryLog', currentHistory, [localStorageHistory, autoBackupHistory]);
assert.strictEqual(history.merged.length, 3, 'missing history is recovered without duplicate IDs');
assert.strictEqual(history.merged.find(row => row.id === 'p1').today, 1000, 'older backup cannot overwrite newer current payment');
assert.strictEqual(history.merged.find(row => row.id === 'p2').today, 300, 'missing localStorage payment is restored');
assert.strictEqual(history.merged.find(row => row.id === 'p3').today, 400, 'missing auto-backup payment is restored');
assert.ok(history.duplicatesRemoved >= 3, 'duplicates from current and recovery sources are detected');

const loans = C.mergeRecoveryArrays('borrowers', [
  { id: 'l1', originalLoanAmount: 50000, updatedAt: '2026-07-22T10:00:00Z' }
], [[
  { id: 'l1', originalLoanAmount: 10000, updatedAt: '2026-07-20T10:00:00Z' },
  { id: 'l2', originalLoanAmount: 20000, updatedAt: '2026-07-21T10:00:00Z' }
]]);
assert.strictEqual(loans.merged.find(row => row.id === 'l1').originalLoanAmount, 50000, 'older loan cannot reduce newer current principal');
assert.ok(loans.merged.some(row => row.id === 'l2'), 'missing loan is recovered');

const deletedPayment = { id: 'p-delete', bid: 'l1', today: 900, revision: 2, updatedAt: '2026-07-22T12:00:00Z' };
const tombstones = C.mergeRecoveryTombstones([], [[
  { kind: 'entryLog', key: C.recoveryKey('entryLog', deletedPayment), revision: 3, deletedAt: '2026-07-22T13:00:00Z', reason: 'payment-delete' }
]]);
const afterCrash = C.mergeRecoveryArrays('entryLog', [], [[deletedPayment]], { tombstones });
assert.strictEqual(afterCrash.merged.length, 0, 'stale IndexedDB payment cannot resurrect after a valid delete');
assert.strictEqual(afterCrash.tombstonesApplied, 1, 'tombstone application is reported');
assert.ok(tombstones.length && !afterCrash.merged.length, 'a tombstone-only crash-recovery source is sufficient to suppress stale data');

const editedPayment = { id: 'p-edit', bid: 'l1', today: 750, revision: 4, updatedAt: '2026-07-22T14:00:00Z' };
const stalePayment = { id: 'p-edit', bid: 'l1', today: 500, revision: 3, updatedAt: '2026-07-22T15:00:00Z' };
const revised = C.mergeRecoveryArrays('entryLog', [editedPayment], [[stalePayment]]);
assert.strictEqual(revised.merged[0].today, 750, 'higher revision wins even when the stale record timestamp is later');

const newerRecreatedPayment = { id: 'p-recreated', bid: 'l1', today: 620, revision: 6, updatedAt: '2026-07-22T16:00:00Z' };
const olderDelete = C.mergeRecoveryTombstones([], [[
  { kind: 'entryLog', key: C.recoveryKey('entryLog', newerRecreatedPayment), revision: 5, deletedAt: '2026-07-22T15:00:00Z', reason: 'old-delete' }
]]);
const recreated = C.mergeRecoveryArrays('entryLog', [newerRecreatedPayment], [], { tombstones: olderDelete });
assert.strictEqual(recreated.merged.length, 1, 'a later legitimate recreate/edit is not hidden by an older tombstone');

const quotaSafeState = C.normalizeState({ tombstones });
assert.strictEqual(quotaSafeState.tombstones.length, 1, 'tombstone ledger survives state normalization used by crash recovery');

const html = fs.readFileSync('www/index.html', 'utf8');
assert.ok(html.includes('onclick="refreshRecoverLocalData(this)"'), 'Settings Backup recovery button is present');
assert.ok(html.includes('async function _vbRefreshRecoverLocalDataImpl()'), 'local recovery workflow is installed');
assert.ok(html.includes('beginAtomicRestore()'), 'recovery uses atomic SQLite staging');
assert.ok(html.includes('_VB_AUTO_BACKUP_LATEST'), 'latest local auto-backup participates in recovery');
assert.ok(html.includes('_VB_TOMBSTONE_KEY'), 'durable tombstone ledger participates in recovery');
assert.ok(html.includes("_vbRecordTombstone('entryLog',e,'payment-delete')"), 'payment delete records a tombstone before removal');
assert.ok(html.includes("_vbRecordTombstone('entryLog',e,'topup-delete')"), 'top-up ledger delete records a tombstone before removal');
assert.ok(html.includes('tombstones:_vbTombstones||[]'), 'automatic snapshot preserves deletion ledger for restart recovery');
assert.ok(html.includes('cm_tombstones_v1: JSON.stringify(_vbTombstones||[])'), 'full atomic persistence includes the tombstone ledger');
assert.ok(html.includes('cm_tombstones_v1:JSON.stringify(_vbTombstones||[])'), 'fast financial persistence includes the tombstone ledger');

console.log(JSON.stringify({
  status: 'PASS',
  counts: { currentHistory: currentHistory.length, recoveredHistory: history.merged.length, recoveredLoans: loans.merged.length },
  checks: ['newer-current-wins', 'higher-revision-wins', 'newer-recreate-wins-over-old-delete', 'missing-history-recovered', 'missing-loan-recovered', 'tombstone-blocks-stale-resurrection', 'crash-restart-ledger', 'quota-safe-ledger-persistence', 'duplicate-removal', 'settings-button', 'IndexedDB-auto-backup-source', 'atomic-SQLite-stage']
}, null, 2));
