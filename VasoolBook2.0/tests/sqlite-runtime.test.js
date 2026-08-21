'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const initSqlJs = require('sql.js');
const { webcrypto } = require('crypto');

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] || null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); }
  };
}

function documentMock() {
  const nodes = new Map();
  return {
    body: { children: [{}] },
    documentElement: { appendChild(node) { if (node.id) nodes.set(node.id, node); } },
    createElement() { return { style: {}, innerHTML: '', remove() { if (this.id) nodes.delete(this.id); } }; },
    getElementById(id) { return nodes.get(id) || null; },
    head: { appendChild() { throw new Error('unexpected script load'); } }
  };
}

async function waitFor(predicate, label) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 8000) throw new Error('Timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const idb = new Map();
  let state = {
    customers: [{ id: 'c1', name: 'Runtime User' }],
    borrowers: [{ id: 'l1', customerId: 'c1', loanno: 'RT-1', name: 'Runtime User', loan: 10000, loanDate: '2026-01-01' }],
    entryLog: [], areas: [], nonAccTxns: [], upiIds: [], expenses: [], cashBook: {}, reminders: [], settings: { company: 'Runtime Test' }, collReports: []
  };
  const localStorage = storage();
  const runtimeConsole = Object.assign({}, console, { error() {} });
  const window = {
    console: runtimeConsole, setTimeout, clearTimeout, Date, Math, JSON, Promise, Uint8Array, TextEncoder, crypto: webcrypto,
    localStorage, document: documentMock(), initSqlJs,
    Capacitor: { getPlatform: () => 'web', Plugins: {} },
    _vbIdbGet: async key => idb.get(key),
    _vbIdbSet: async (key, value) => { idb.set(key, value); return true; },
    _vbIdbSetMany: async values => { Object.keys(values).forEach(key => idb.set(key, values[key])); return true; },
    VBStateBridge: {
      capture: () => state,
      apply: next => { state = next; },
      appVersion: () => ({ name: 'test', code: '1' })
    },
    saveState() {}, saveStateFast() {},
    showToast() {},
    onload() {}
  };
  window.window = window;
  window.self = window;
  const context = vm.createContext(window);
  vm.runInContext(fs.readFileSync('www/js/vasoolbook-sqlite-core.js', 'utf8'), context, { filename: 'vasoolbook-sqlite-core.js' });
  vm.runInContext(fs.readFileSync('www/js/sqliteDataIntegrity.js', 'utf8'), context, { filename: 'sqliteDataIntegrity.js' });
  window.onload({ type: 'load' });
  await waitFor(() => window.VBSqliteIntegrity.isReady(), 'SQLite activation');
  assert.strictEqual(window.VBSqliteIntegrity.isActive(), true, 'migration activates only after verification');
  assert.ok(localStorage.getItem('vb_sqlite_active_v1'), 'activation marker is written after commit');
  assert.ok(Array.from(idb.keys()).some(key => key.startsWith('vb_sqlite_emergency_')), 'verified emergency snapshot exists');
  assert.strictEqual(state.borrowers[0].originalLoanAmount, 10000, 'immutable original principal is pinned into active state');

  state.entryLog.push({ id: 'p1', bid: 'l1', date: '2026-02-01', today: 1000, principalComponent: 900, interestComponent: 100, pay: 'Cash' });
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  let rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n,SUM(gross_paise) total FROM v_current_financial_transactions WHERE legacy_id='p1'");
  assert.strictEqual(Number(rows[0].n), 1, 'payment is committed once');
  assert.strictEqual(Number(rows[0].total), 100000, 'payment is committed in paise');

  state.entryLog[0].today = 1200;
  state.entryLog[0].principalComponent = 1100;
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) revisions FROM financial_transactions WHERE legacy_id='p1'");
  assert.strictEqual(Number(rows[0].revisions), 3, 'financial edit creates reversal and replacement rows');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n,SUM(gross_paise) total FROM v_current_financial_transactions WHERE legacy_id='p1'");
  assert.strictEqual(Number(rows[0].n), 1, 'only the replacement is current');
  assert.strictEqual(Number(rows[0].total), 120000, 'replacement has corrected amount');

  const committedState = JSON.parse(JSON.stringify(state));
  state.borrowers[0].originalLoanAmount = 1;
  await window.saveState();
  await assert.rejects(window.VBSqliteIntegrity.flush(), /Immutable loan origin mismatch/, 'invalid origin update is reported');
  assert.strictEqual(state.borrowers[0].originalLoanAmount, committedState.borrowers[0].originalLoanAmount, 'failed save restores last committed UI state');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT original_loan_amount_paise n FROM loans WHERE legacy_id='l1'");
  assert.strictEqual(Number(rows[0].n), 1000000, 'failed save leaves SQLite principal unchanged');

  const stage = await window.VBSqliteIntegrity.beginAtomicRestore();
  state.entryLog.push({ id: 'p2', bid: 'l1', date: '2026-03-01', today: 500, principalComponent: 500 });
  await window.saveState();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM v_current_financial_transactions WHERE legacy_id='p2'");
  assert.strictEqual(Number(rows[0].n), 0, 'restore staging suppresses partial saves');
  await window.VBSqliteIntegrity.commitAtomicRestore(stage, 'runtime-test');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM v_current_financial_transactions WHERE legacy_id='p2'");
  assert.strictEqual(Number(rows[0].n), 1, 'restore candidate commits once after validation');

  state.borrowers[0].collectionDone = true;
  state.borrowers[0].nextEligibleDate = '2026-07-27';
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT status FROM loans WHERE legacy_id='l1'");
  assert.strictEqual(rows[0].status, 'temporarily_closed', 'Next Week state is persisted as temporarily closed');
  state.borrowers[0].collectionDone = false;
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT event_type FROM loan_events WHERE loan_id=(SELECT id FROM loans WHERE legacy_id='l1') ORDER BY occurred_at,id");
  assert.ok(rows.some(row => row.event_type === 'next_week') && rows.some(row => row.event_type === 'reopened'), 'close and reopen transitions are append-only events');

  state.entryLog = state.entryLog.filter(entry => entry.id !== 'p1');
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM v_current_financial_transactions WHERE legacy_id='p1'");
  assert.strictEqual(Number(rows[0].n), 0, 'deleted payment is excluded through a tombstone revision');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM financial_transactions WHERE legacy_id='p1' AND status='tombstone'");
  assert.strictEqual(Number(rows[0].n), 1, 'deleted payment history remains immutable in the ledger');

  state.expenses.push({ id: 'expense-1', date: '2026-04-05', amount: 125.5, mode: 'Cash', category: 'Travel', areaId: 'area-1' });
  state.nonAccTxns.push({ id: 'non-account-1', date: '2026-04-05', amount: 75.25, pay: 'UPI', type: 'cash_out', areaId: 'area-1' });
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n,SUM(amount_paise) total FROM expenses WHERE legacy_id='expense-1' AND deleted_at IS NULL");
  assert.deepStrictEqual({ n: Number(rows[0].n), total: Number(rows[0].total) }, { n: 1, total: 12550 }, 'expense projection is committed in paise');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n,SUM(amount_paise) total FROM non_account_transactions WHERE legacy_id='non-account-1' AND deleted_at IS NULL");
  assert.deepStrictEqual({ n: Number(rows[0].n), total: Number(rows[0].total) }, { n: 1, total: 7525 }, 'non-account projection is committed in paise');

  state.expenses = [];
  state.nonAccTxns = [];
  await window.saveState();
  await window.VBSqliteIntegrity.flush();
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM expenses WHERE legacy_id='expense-1' AND deleted_at IS NOT NULL");
  assert.strictEqual(Number(rows[0].n), 1, 'expense delete becomes a normalized soft delete');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM non_account_transactions WHERE legacy_id='non-account-1' AND deleted_at IS NOT NULL");
  assert.strictEqual(Number(rows[0].n), 1, 'non-account delete becomes a normalized soft delete');
  rows = await window.VBSqliteIntegrity.adapter().query("SELECT COUNT(*) n FROM tombstones WHERE entity_table IN ('expenses','non_account_transactions')");
  assert.strictEqual(Number(rows[0].n), 2, 'operational financial deletes retain tombstones for audit and recovery');

  const liveBeforeStage = await window.VBSqliteIntegrity.adapter().query('SELECT payload_checksum_sha256 checksum,revision FROM app_state WHERE id=1');
  const liveLedgerBeforeStage = await window.VBSqliteIntegrity.adapter().query('SELECT COUNT(*) n FROM financial_transactions');
  const recoveryCandidate = JSON.parse(JSON.stringify(state));
  recoveryCandidate.entryLog.push({ id: 'recovery-only-payment', bid: 'l1', date: '2026-04-01', today: 250, principalComponent: 250 });
  const recoveryValidation = await window.VBSqliteIntegrity.validateRestoreCandidate(recoveryCandidate);
  assert.strictEqual(recoveryValidation.ok, true, 'valid recovery candidate passes isolated SQLite staging');
  assert.strictEqual(Number(recoveryValidation.foreignKeys), 0, 'recovery staging has no foreign-key violations');
  const liveAfterStage = await window.VBSqliteIntegrity.adapter().query('SELECT payload_checksum_sha256 checksum,revision FROM app_state WHERE id=1');
  const liveLedgerAfterStage = await window.VBSqliteIntegrity.adapter().query('SELECT COUNT(*) n FROM financial_transactions');
  assert.deepStrictEqual(liveAfterStage, liveBeforeStage, 'recovery staging does not modify the live app-state row');
  assert.deepStrictEqual(liveLedgerAfterStage, liveLedgerBeforeStage, 'recovery staging does not modify the live financial ledger');

  const renamedCandidate = JSON.parse(JSON.stringify(state));
  renamedCandidate.borrowers[0].legacyLoanIds = ['old-loan-id'];
  renamedCandidate.entryLog.push({ id: 'renamed-recovery-payment', bid: 'old-loan-id', date: '2026-04-02', today: 100 });
  const renamedValidation = await window.VBSqliteIntegrity.validateRestoreCandidate(renamedCandidate);
  assert.strictEqual(renamedValidation.relationshipReport.repairedLinks, 1, 'old loan ID is mapped to the loaded loan before history validation');
  assert.strictEqual(renamedValidation.repairedState.entryLog.find(row => row.id === 'renamed-recovery-payment').bid, 'l1', 'staging state contains repaired loan relationship');

  const mappedCandidate = JSON.parse(JSON.stringify(state));
  mappedCandidate.entryLog.push({ id: 'mapped-recovery-payment', bid: 'migration-old-loan', date: '2026-04-03', today: 75 });
  const mappedValidation = await window.VBSqliteIntegrity.validateRestoreCandidate(mappedCandidate, { idMappings: [{ legacyId: 'migration-old-loan', canonicalId: 'l1' }] });
  assert.strictEqual(mappedValidation.relationshipReport.repairedLinks, 1, 'explicit migration ID mapping repairs renamed loan relationship');
  assert.strictEqual(mappedValidation.repairedState.entryLog.find(row => row.id === 'mapped-recovery-payment').bid, 'l1', 'migration ID mapping is applied only to staging state');

  const orphanCandidate = JSON.parse(JSON.stringify(state));
  orphanCandidate.entryLog.push({ id: 'orphan-recovery-payment', bid: 'missing-loan', date: '2026-04-04', today: 100 });
  const orphanValidation = await window.VBSqliteIntegrity.validateRestoreCandidate(orphanCandidate);
  assert.strictEqual(orphanValidation.ok, true, 'a small number of true orphan records does not reject the whole backup');
  assert.strictEqual(orphanValidation.relationshipReport.unrepairableLinks, 1, 'true orphan is reported as unrepairable');
  assert.ok(orphanValidation.warnings.some(message => /preserved with warning/.test(message)), 'unrepairable relationship produces a visible warning');
  const liveAfterOrphanValidation = await window.VBSqliteIntegrity.adapter().query('SELECT payload_checksum_sha256 checksum,revision FROM app_state WHERE id=1');
  assert.deepStrictEqual(liveAfterOrphanValidation, liveBeforeStage, 'relationship diagnostics remain read-only against live SQLite');

  const duplicateCandidate = JSON.parse(JSON.stringify(state));
  duplicateCandidate.borrowers.push({ id: 'l2', customerId: 'c1', loanno: 'RT-1', name: 'Runtime User', loan: 5000, loanDate: '2026-05-01' });
  const duplicateValidationOne = await window.VBSqliteIntegrity.validateRestoreCandidate(duplicateCandidate);
  const duplicateValidationTwo = await window.VBSqliteIntegrity.validateRestoreCandidate(duplicateCandidate);
  assert.strictEqual(duplicateValidationOne.relationshipReport.duplicateLoanCount, 1, 'backup duplicate loan number is reported');
  assert.strictEqual(duplicateValidationOne.relationshipReport.stagingDuplicateCount, 0, 'fresh staging contains no previous duplicate rows');
  assert.strictEqual(duplicateValidationOne.stagingCleanup, 'deleted', 'first temporary staging database is deleted after scan');
  assert.strictEqual(duplicateValidationTwo.stagingCleanup, 'deleted', 'second temporary staging database is deleted after scan');
  assert.notStrictEqual(duplicateValidationOne.stagingDatabaseId, duplicateValidationTwo.stagingDatabaseId, 'every recovery scan uses a brand-new temporary database ID');
  assert.ok(duplicateValidationOne.stagingLifecycle.some(row => row.event === 'connection_closed'), 'successful scan closes its staging connection');
  assert.ok(duplicateValidationOne.stagingLifecycle.some(row => row.event === 'delete_completed'), 'successful scan deletes its staging database');

  const cancelledLogStart = window.VBSqliteIntegrity.getRecoveryLifecycleLog().length;
  await assert.rejects(
    window.VBSqliteIntegrity.validateRestoreCandidate(recoveryCandidate, { signal: { aborted: true } }),
    error => error && error.name === 'AbortError',
    'cancelled recovery scan exits through the cleanup path'
  );
  const cancelledLifecycle = window.VBSqliteIntegrity.getRecoveryLifecycleLog().slice(cancelledLogStart);
  assert.ok(cancelledLifecycle.some(row => row.event === 'staging_database_created'), 'cancelled scan creates an isolated fresh stage');
  assert.ok(cancelledLifecycle.some(row => row.event === 'connection_closed'), 'cancelled scan closes the staging connection');
  assert.ok(cancelledLifecycle.some(row => row.event === 'delete_completed'), 'cancelled scan deletes the staging database');

  const invalidCandidate = JSON.parse(JSON.stringify(state));
  invalidCandidate.borrowers.push(JSON.parse(JSON.stringify(invalidCandidate.borrowers[0])));
  const failedLogStart = window.VBSqliteIntegrity.getRecoveryLifecycleLog().length;
  await assert.rejects(
    window.VBSqliteIntegrity.validateRestoreCandidate(invalidCandidate),
    /duplicate loan ID/,
    'failed validation reports the backup defect'
  );
  const failedLifecycle = window.VBSqliteIntegrity.getRecoveryLifecycleLog().slice(failedLogStart);
  assert.ok(failedLifecycle.some(row => row.event === 'connection_closed'), 'failed validation closes the staging connection');
  assert.ok(failedLifecycle.some(row => row.event === 'delete_completed'), 'failed validation deletes the staging database');

  const scanAfterFailure = await window.VBSqliteIntegrity.validateRestoreCandidate(recoveryCandidate);
  assert.strictEqual(scanAfterFailure.ok, true, 'a clean scan succeeds after a previous failed validation');
  assert.notStrictEqual(scanAfterFailure.stagingDatabaseId, duplicateValidationTwo.stagingDatabaseId, 'scan after failure receives another unique staging database');
  const liveAfterRepeatedScans = await window.VBSqliteIntegrity.adapter().query('SELECT payload_checksum_sha256 checksum,revision FROM app_state WHERE id=1');
  assert.deepStrictEqual(liveAfterRepeatedScans, liveBeforeStage, 'repeated duplicate diagnostics remain read-only against live SQLite');

  console.log(JSON.stringify({ status: 'PASS', checks: ['activation-gate', 'emergency-snapshot', 'payment-create', 'reversal-edit', 'failed-save-rollback', 'atomic-restore-staging', 'next-week-close', 'reopen-event', 'payment-tombstone', 'temporary-recovery-validation', 'staging-read-only', 'renamed-loan-repair', 'migration-id-map-repair', 'unrepairable-orphan-warning', 'duplicate-loan-warning', 'fresh-staging-per-scan', 'staging-deleted-after-scan', 'cancelled-scan-cleanup', 'failed-validation-cleanup', 'scan-after-failure', 'multiple-scans-one-session', 'repeated-scan-read-only'] }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
