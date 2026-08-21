'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('www/js/sqliteDataIntegrity.js', 'utf8');

function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'expected lifecycle block: ' + startMarker);
  return source.slice(start, end);
}

const closeHandle = block('NativeAdapter.prototype.closeHandle', 'NativeAdapter.prototype.ensureDeleteConnection');
const destroy = block('NativeAdapter.prototype.destroy', 'function WebAdapter');
const validation = block('async function validateRestoreCandidate', 'async function migrate');

assert.ok(closeHandle.includes('this.p.close({database:this.name,readonly:false})'), 'SQLite handle is closed without removing its manager entry');
assert.ok(!closeHandle.includes('closeConnection('), 'closeConnection is not called before deleteDatabase');
assert.ok(closeHandle.includes('this.p.isDBOpen'), 'connection manager is polled until the database reports closed');

const closeIndex = destroy.indexOf('await this.closeHandle()');
const deleteIndex = destroy.indexOf('await this.p.deleteDatabase');
const releaseIndex = destroy.indexOf('await this.releaseManager()');
assert.ok(closeIndex >= 0 && deleteIndex > closeIndex && releaseIndex > deleteIndex, 'cleanup order is close, delete, then manager release');
assert.ok(destroy.includes('attempt<3'), 'deleteDatabase has bounded retry handling');
assert.ok(destroy.includes('ensureDeleteConnection'), 'missing connection-manager entry is recreated only for deletion');
assert.ok(destroy.includes("status:deleted?'deleted':'released_delete_deferred'"), 'failed deletion still reports released resources');

assert.ok(source.includes("C.DATABASE_NAME+'_recovery_stage_'+Date.now()+'_'+C.uuid()"), 'every staging database name contains timestamp and UUID entropy');
assert.ok(source.includes("this.stage&&this.name===C.DATABASE_NAME"), 'production database name is rejected for recovery staging');
assert.ok(validation.includes('finally{') && validation.includes('cleanup=await temp.destroy()'), 'validation always destroys staging resources in finally');
assert.ok(validation.includes('throwIfCancelled(options)'), 'cancelled scans use the same cleanup path');
assert.ok(!validation.includes('adapter.set(') && !validation.includes('adapter.execute('), 'recovery validation does not write through the production adapter');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'close-handle-before-delete',
    'connection-manager-close-confirmation',
    'delete-retry',
    'delete-connection-recovery',
    'manager-release-after-delete',
    'unique-stage-name',
    'production-name-guard',
    'finally-cleanup',
    'cancel-cleanup',
    'production-write-isolation'
  ]
}, null, 2));
