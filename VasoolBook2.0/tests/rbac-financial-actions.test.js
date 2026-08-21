'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const index = fs.readFileSync('www/index.html', 'utf8');
const sql = fs.readFileSync('www/sql-server.js', 'utf8');
const cloud = fs.readFileSync('www/cloud-storage.js', 'utf8');

function slicePolicy(source) {
  const start = source.indexOf('var _MUM_ROLE_PERMISSIONS=');
  const end = source.indexOf('window.VBPermissions={can:_mumCan,require:_mumRequire};', start);
  assert.ok(start >= 0 && end >= start, 'central RBAC policy exists');
  return source.slice(start, end) + 'window.VBPermissions={can:_mumCan,require:_mumRequire};';
}

let activeUser = null;
const audits = [];
const context = {
  window: {},
  String,
  _mumCurrentUser: () => activeUser,
  syncAudit: (...args) => audits.push(args),
  showToast: () => {}
};
vm.createContext(context);
vm.runInContext(slicePolicy(index), context);

function can(role, action) {
  activeUser = role ? { role } : null;
  return context._mumCan(action);
}

assert.equal(can('Admin', 'data.restore'), true, 'Admin can restore');
assert.equal(can('Manager', 'payment.create'), true, 'Manager can collect');
assert.equal(can('Manager', 'backup.run'), true, 'Manager can run backup');
assert.equal(can('Manager', 'data.restore'), false, 'Manager cannot restore');
assert.equal(can('Collector', 'payment.create'), true, 'Collector can collect');
assert.equal(can('Collector', 'payment.edit'), false, 'Collector cannot edit a ledger payment');
assert.equal(can('Collector', 'data.export'), false, 'Collector cannot export data');
assert.equal(can('Employee', 'expense.create'), false, 'Employee is deny-by-default');
assert.equal(can(null, 'payment.create'), false, 'Signed-out caller is denied');
activeUser = { role: 'Collector' };
assert.equal(context._mumRequire('data.restore'), false, 'denied operation stops before work begins');
assert.equal(audits.length, 1, 'denial is audited');

[
  ["saveEntry", "payment.create"], ["saveEditPayModal", "payment.edit"],
  ["saveBorrower", "borrower.create"], ["deleteBorrower", "borrower.delete"],
  ["saveTopUp", "topup.create"], ["deleteTopUp", "topup.delete"],
  ["saveExpenseEntry", "expense.create"], ["deleteExpense", "expense.delete"],
  ["saveNatTxn", "nonaccount.create"], ["deleteNatTxn", "nonaccount.delete"],
  ["backupToDrive", "backup.run"], ["restoreFromDrive", "data.restore"],
  ["exportData", "data.export"], ["importData", "data.import"]
].forEach(([name, action]) => {
  const marker = `function ${name}(`;
  const asyncMarker = `async function ${name}(`;
  const start = Math.max(index.indexOf(marker), index.indexOf(asyncMarker));
  assert.ok(start >= 0, `${name} exists`);
  const body = index.slice(start, start + (name === 'saveTopUp' ? 1200 : 260));
  assert.ok(
    body.includes(`_mumRequire('${action}')`) ||
    (name === 'saveBorrower' && body.includes('_mumRequire(editingId?')) ||
    (name === 'saveTopUp' && body.includes('_mumRequire(_topupEditId?')),
    `${name} enforces ${action}`
  );
});

assert.ok(sql.includes("window.VBPermissions.require(permissionAction)"), 'SQL actions enforce RBAC at the dispatcher');
assert.ok(cloud.includes("window.VBPermissions.require(permissionAction)"), 'Cloud actions enforce RBAC at the dispatcher');

console.log('RBAC financial action checks passed');
