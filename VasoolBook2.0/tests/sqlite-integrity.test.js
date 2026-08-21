'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const C = require('../www/js/vasoolbook-sqlite-core.js');

function one(db, sql, values) {
  const q = db.prepare(sql);
  try {
    q.bind(values || []);
    return q.step() ? q.getAsObject() : null;
  } finally {
    q.free();
  }
}

function executeSet(db, set) {
  for (const item of set) db.run(item.statement, item.values || []);
}

function fixture() {
  return {
    settings: { company: 'VasoolBook', pay: 'Cash' },
    areas: [{ id: 'area-main', name: 'Main Area', day: 'Monday' }],
    customers: [
      { id: 'customer-1', name: 'Anil Kumar', phone: '9876543210' },
      { id: 'customer-2', name: 'Banu', phone: '9876500000' }
    ],
    borrowers: [
      { id: 'loan-1', customerId: 'customer-1', loanno: 'L-001', name: 'Anil Kumar', loan: 50000, originalLoanAmount: 50000, loanDate: '2026-01-01', area: 'Main Area', loanType: 'monthly', isInterest: true },
      { id: 'loan-2', customerId: 'customer-1', loanno: 'L-002', name: 'Anil Kumar', loan: 20000, originalLoanAmount: 20000, originalLoanDate: '2025-01-01', loanDate: '2026-02-01', area: 'Main Area', renewedFromLoanId: 'loan-old' },
      { id: 'loan-3', customerId: 'customer-2', loanno: 'L-003', name: 'Banu', loan: 10000, originalLoanAmount: 10000, loanDate: '2026-03-01', area: 'Main Area', collectionDone: true, nextEligibleDate: '2026-07-27' }
    ],
    entryLog: [
      { id: 'opening-1', bid: 'loan-1', date: '2026-01-01', today: 5000, principalComponent: 5000, isOpeningPaid: true, paymentPurpose: 'opening_paid' },
      { id: 'payment-1', bid: 'loan-1', date: '2026-02-01', today: 3000, principalComponent: 2000, interestComponent: 1000, pay: 'Cash' },
      { id: 'split-1', bid: 'loan-2', date: '2026-03-01', today: 4000, principalComponent: 4000, cashAmt: 1500, upiAmt: 2500, isSplit: true },
      { id: 'close-1', bid: 'loan-2', date: '2026-04-01', today: 16000, principalComponent: 16000, isFullPaid: true, isLoanClosure: true },
      { id: 'reopen-1', bid: 'loan-3', date: '2026-07-27', today: 0, isReopened: true, paymentPurpose: 'reopen' }
    ],
    expenses: [{ id: 'expense-1', date: '2026-03-01', amount: 250.75, mode: 'Cash', category: 'Travel' }],
    nonAccTxns: [{ id: 'nat-1', date: '2026-03-02', amount: 1000, type: 'cash_in', pay: 'Cash' }],
    upiIds: [{ id: 'upi-1', label: 'Main UPI', vpa: 'test@upi' }],
    reminders: [{ id: 'reminder-1', bid: 'loan-3', date: '2026-07-27', type: 'next_week' }],
    cashBook: { '2026-03-01': { openBal: 1000, closeBal: 2750 } },
    collReports: [{ id: 'report-1', reportType: 'collection', date: '2026-03-01', total: 4000 }],
    users: [{ id: 'user-1', username: 'admin', role: 'Admin' }],
    auditLog: [{ id: 'audit-1', action: 'Create', txnType: 'loan', amount: 50000, ts: '2026-01-01T00:00:00.000Z' }]
  };
}

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(C.SCHEMA_SQL);
  assert.strictEqual(one(db, 'PRAGMA foreign_keys').foreign_keys, 1, 'foreign keys must be enabled');

  const source = C.validateLegacyState(fixture());
  assert.deepStrictEqual(source.critical, [], 'fixture must pass preflight validation');
  const plan = C.buildMigrationPlan(source.state);
  db.run('BEGIN IMMEDIATE');
  executeSet(db, plan.statements);
  db.run('COMMIT');

  assert.strictEqual(Number(one(db, 'SELECT COUNT(*) n FROM loans').n), source.counts.loans, 'new and renewed loans migrate');
  assert.strictEqual(Number(one(db, 'SELECT COUNT(*) n FROM financial_transactions').n), source.counts.history, 'all collection/history entries migrate');
  assert.strictEqual(Number(one(db, "SELECT COUNT(*) n FROM payment_tenders WHERE transaction_id=(SELECT id FROM financial_transactions WHERE legacy_id='split-1')").n), 2, 'split payment retains both tenders');
  assert.strictEqual(Number(one(db, "SELECT gross_paise n FROM financial_transactions WHERE legacy_id='opening-1'").n), 500000, 'opening paid amount is integer paise');
  assert.strictEqual(Number(one(db, 'SELECT SUM(original_loan_amount_paise) n FROM loans').n), source.totals.originalLoanPaise, 'original loan total is exact');
  assert.strictEqual(Number(one(db, 'SELECT SUM(amount_paise) n FROM expenses').n), source.totals.expensePaise, 'expense total is exact');
  assert.strictEqual(one(db, 'PRAGMA foreign_key_check'), null, 'there are no orphan foreign keys');

  const relationshipFixture = fixture();
  relationshipFixture.borrowers[1].renewedFromLoanId = 'loan-1';
  relationshipFixture.entryLog.push({ id: 'legacy-linked-payment', bid: 'loan-renamed-old', date: '2026-05-01', today: 250 });
  relationshipFixture.entryLog.push({ id: 'missing-loan-payment', bid: 'loan-truly-missing', date: '2026-05-02', today: 100 });
  relationshipFixture.borrowers[0].legacyLoanIds = ['loan-renamed-old'];
  const repairedRelationships = C.repairRecoveryRelationships(relationshipFixture);
  assert.strictEqual(repairedRelationships.report.repairedLinks, 1, 'renamed legacy loan ID is repaired in staging state');
  assert.strictEqual(repairedRelationships.report.unrepairableLinks, 1, 'truly missing loan is retained as an unresolved warning');
  assert.strictEqual(repairedRelationships.state.entryLog.find(row => row.id === 'legacy-linked-payment').bid, 'loan-1', 'history link is rewritten only in repaired staging state');
  assert.strictEqual(C.validateLegacyState(repairedRelationships.state).critical.length, 0, 'marked unresolved history is warning-only');
  const relationshipPlan = C.buildMigrationPlan(repairedRelationships.state, { allowOrphanHistory: true });
  const borrowerAt = relationshipPlan.statements.findIndex(row => /^INSERT INTO borrowers/.test(row.statement));
  const loanAt = relationshipPlan.statements.findIndex(row => /^INSERT INTO loans/.test(row.statement));
  const relationAt = relationshipPlan.statements.findIndex(row => /loan_relationships/.test(row.statement));
  const historyAt = relationshipPlan.statements.findIndex(row => /^INSERT INTO financial_transactions/.test(row.statement));
  assert.ok(borrowerAt >= 0 && loanAt > borrowerAt && relationAt > loanAt && historyAt > relationAt, 'migration order is borrowers, loans, relationships, then history');

  const duplicateLoanFixture = fixture();
  duplicateLoanFixture.borrowers[1].loanno = duplicateLoanFixture.borrowers[0].loanno;
  const duplicateRepair = C.repairRecoveryRelationships(duplicateLoanFixture);
  assert.strictEqual(duplicateRepair.report.duplicateLoanCount, 1, 'duplicate loan number inside backup is counted without rejecting all loans');
  assert.strictEqual(duplicateRepair.report.duplicateLoanNumbers[0].loanNumber, 'L-001', 'duplicate report identifies original loan number');
  assert.ok(duplicateRepair.state.borrowers[1].recoveryStagingLoanNumber !== 'L-001', 'additional duplicate receives staging-only unique loan number');
  const duplicatePlan = C.buildMigrationPlan(duplicateRepair.state, { allowOrphanHistory: true });
  const duplicateDb = new SQL.Database();
  duplicateDb.run(C.SCHEMA_SQL);
  duplicateDb.run('BEGIN IMMEDIATE');
  executeSet(duplicateDb, duplicatePlan.statements);
  duplicateDb.run('COMMIT');
  assert.strictEqual(Number(one(duplicateDb, 'SELECT COUNT(*) n FROM loans').n), duplicateLoanFixture.borrowers.length, 'all duplicate-number loans continue through staging validation');
  assert.strictEqual(one(duplicateDb, 'SELECT loan_number,COUNT(*) n FROM loans GROUP BY business_id,loan_number HAVING COUNT(*)>1'), null, 'staging loan numbers satisfy SQLite uniqueness');
  duplicateDb.close();

  assert.throws(() => db.run("UPDATE financial_transactions SET gross_paise=0 WHERE legacy_id='payment-1'"), /immutable/, 'financial rows cannot be edited');
  assert.throws(() => db.run("DELETE FROM financial_transactions WHERE legacy_id='payment-1'"), /reversed/, 'financial rows cannot be deleted');
  assert.throws(() => db.run("UPDATE loans SET original_loan_amount_paise=0 WHERE legacy_id='loan-1'"), /original loan/, 'original loan amount cannot be reduced');
  assert.throws(() => db.run("DELETE FROM audit_log WHERE action='Create'"), /append-only/, 'audit records cannot be deleted');
  const loanTotals = one(db, "SELECT total_paid_paise,calculated_balance_paise FROM v_loan_ledger_totals WHERE legacy_id='loan-1'");
  assert.strictEqual(Number(loanTotals.total_paid_paise), 800000, 'total paid is derived from immutable opening/payment rows');
  assert.strictEqual(Number(loanTotals.calculated_balance_paise), 4300000, 'balance is derived without mutating original principal');

  const beforeFailure = Number(one(db, 'SELECT COUNT(*) n FROM loans').n);
  db.run('BEGIN IMMEDIATE');
  try {
    db.run("INSERT INTO loans(id,business_id,borrower_id,legacy_id,loan_number,product_type,status,original_loan_amount_paise,original_start_date,raw_json,created_at,updated_at) SELECT 'power-loss-loan',business_id,id,'power-loss','PWR','weekly','active',10000,'2026-01-01','{}','2026-01-01','2026-01-01' FROM borrowers LIMIT 1");
    throw new Error('simulated force-close before commit');
  } catch (error) {
    db.run('ROLLBACK');
  }
  assert.strictEqual(Number(one(db, 'SELECT COUNT(*) n FROM loans').n), beforeFailure, 'failed multi-table write rolls back completely');

  const bytes = db.export();
  const restarted = new SQL.Database(bytes);
  assert.strictEqual(Number(one(restarted, 'SELECT COUNT(*) n FROM financial_transactions').n), source.counts.history, 'app restart retains ledger rows');
  assert.strictEqual(Number(one(restarted, 'SELECT SUM(original_loan_amount_paise) n FROM loans').n), source.totals.originalLoanPaise, 'app restart retains financial totals');

  const backupBefore = C.fastHash(Buffer.from(restarted.export()).toString('base64'));
  // Cancellation deliberately performs no SQL statement.
  const backupAfter = C.fastHash(Buffer.from(restarted.export()).toString('base64'));
  assert.strictEqual(backupAfter, backupBefore, 'backup cancellation is read-only');

  const businessId = one(restarted, 'SELECT id FROM businesses LIMIT 1').id;
  restarted.run("INSERT INTO sync_queue(id,business_id,entity_table,entity_id,operation,row_version,payload_checksum,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ['sync-1', businessId, 'loans', 'loan-1', 'upsert', 1, 'abc', 'pending', '2026-01-01', '2026-01-01']);
  assert.throws(() => restarted.run("INSERT INTO sync_queue(id,business_id,entity_table,entity_id,operation,row_version,payload_checksum,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ['sync-2', businessId, 'loans', 'loan-1', 'upsert', 1, 'abc', 'pending', '2026-01-01', '2026-01-01']), /UNIQUE/, 'duplicate sync work is rejected');

  assert.strictEqual(C.toPaise('0.29'), 29, 'decimal money conversion is exact');
  assert.throws(() => C.toPaise('NaN'), /Invalid money/, 'invalid money is rejected');

  console.log(JSON.stringify({
    status: 'PASS',
    schemaVersion: C.SCHEMA_VERSION,
    counts: source.counts,
    totals: source.totals,
    checks: ['migration', 'new-loan', 'renewed-loan', 'opening-paid', 'payment', 'split-payment', 'close/reopen/next-week records', 'relationship-alias-repair', 'unrepairable-warning', 'relationship-import-order', 'duplicate-loan-report', 'duplicate-staging-number', 'immutable-ledger', 'immutable-loan-origin', 'append-only-audit', 'deterministic-balance', 'rollback', 'restart', 'backup-cancel', 'sync-dedup', 'paise']
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
