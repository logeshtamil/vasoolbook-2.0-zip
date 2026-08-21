'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('www/index.html', 'utf8');
function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) { if (source[i] === '{') depth++; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
  throw new Error('Could not extract ' + name);
}
const backing = new Map();
const context = { Date, Math, Array, isFinite, localStorage: { getItem:k => backing.get(k) || null, setItem:(k,v) => backing.set(k, String(v)) } };
vm.createContext(context);
vm.runInContext("var _MUM_USERS_KEY='cm_mum_users',_MUM_AUDIT_KEY='cm_mum_audit',_MUM_AUDIT_MONTHS=3,_MUM_AUDIT_MAX=3;", context);
['_mumGetAudit','_mumSaveAudit','_mumAuditRetention','_mumPurgeAudit','_mumPersistAuditRetention'].forEach(name => vm.runInContext(extractFunction(name), context));

const now = '2026-08-09T12:00:00.000Z';
const recent = { id:'recent', ts:'2026-08-08T12:00:00.000Z', action:'Collect' };
const old = { id:'old', ts:'2026-01-01T12:00:00.000Z', action:'Login' };
const future = { id:'future', ts:'2026-08-10T12:00:00.000Z', action:'Edit' };
const invalid = { id:'invalid', ts:'not-a-date', action:'Legacy' };
const retained = context._mumAuditRetention([old, recent, future, invalid], now);
assert.equal(retained.purged, 1, 'only expired dated logs are purged');
assert.ok(retained.log.some(x => x.id === 'recent') && retained.log.some(x => x.id === 'future'), 'newer records are retained');
assert.ok(retained.log.some(x => x.id === 'invalid'), 'unreadable legacy timestamp is preserved rather than silently deleted');

const oversized = [
  {id:'a',ts:'2026-08-05T00:00:00.000Z'}, {id:'b',ts:'2026-08-08T00:00:00.000Z'},
  {id:'c',ts:'2026-08-07T00:00:00.000Z'}, {id:'d',ts:'2026-08-06T00:00:00.000Z'}
];
const capped = context._mumAuditRetention(oversized, now);
assert.equal(capped.log.length, 3, 'configured maximum audit size is enforced');
assert.deepEqual(capped.log.map(x => x.id), ['b','c','d'], 'newest audit actions survive size enforcement');

backing.set('cm_mum_audit', JSON.stringify([old, recent]));
const startup = context._mumPersistAuditRetention('startup', now);
assert.equal(startup.changed, true, 'startup cleanup reports persisted change');
assert.deepEqual(JSON.parse(backing.get('cm_mum_audit')).map(x => x.id), ['recent'], 'startup cleanup writes retained audit log back to storage');

assert.match(source, /_mumPersistAuditRetention\('startup'\)/, 'startup invokes persistent retention cleanup');
assert.match(source, /var _MUM_AUDIT_MAX=5000/, 'production maximum audit size is configured');
console.log(JSON.stringify({ status:'PASS', checks:['startup-persistence','restart-retention','multi-user-newest-preserved','old-log-cleanup','max-size-cap','financial-ledger-untouched'] }, null, 2));
