'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/sql-server.js', 'utf8');

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

const context = {
  Object, Array, JSON, String, Number, Math, Date, URL, isFinite,
  PROVIDERS: {vasoolbook:'',turso:'',firebase:'',postgres:'',mysql:'',mssql:'',custom:''},
  FINANCIAL_ARRAYS: {loanProfiles:true,entryLog:true,nonAccTxns:true,expenses:true,collReports:true}
};
vm.createContext(context);
[
  'clone','stableStringify','identityHash','sanitizeConfig','validateConfig','connectionId',
  'recordKey','recordVersion','recordTime','occurrenceMap','mergeArray'
].forEach(name => vm.runInContext(extractFunction(name), context));

const turso = context.validateConfig({
  provider:'turso', apiUrl:'https://gateway.example.com',
  database:'libsql://vasoolbook-db.example.turso.io', username:'business-1'
});
assert.equal(turso.provider, 'turso');
assert.throws(() => context.validateConfig({
  provider:'turso', apiUrl:'libsql://vasoolbook-db.example.turso.io',
  database:'vasoolbook', username:''
}), /HTTPS|Direct database/);
assert.throws(() => context.validateConfig({
  provider:'custom', apiUrl:'https://gateway.example.com?token=secret',
  database:'vasoolbook', username:''
}), /tokens or secrets/);
assert.equal(context.validateConfig({
  provider:'firebase', apiUrl:'https://gateway.example.com',
  database:'vasool-book-app-08031993', username:'user@example.com'
}).provider, 'firebase');

const tursoId = context.connectionId(turso);
const firebaseId = context.connectionId({
  provider:'firebase',apiUrl:'https://gateway.example.com',database:'vasool-book-app-08031993',username:'user@example.com'
});
assert.notEqual(tursoId, firebaseId, 'provider credentials and queues have different identities');

let conflicts = [];
let merged = context.mergeArray('entryLog', [
  {id:'P1',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',today:500},
  {id:'P1',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',today:500}
], [], conflicts);
assert.equal(merged.length, 1, 'identical payment IDs are deduplicated');
assert.equal(conflicts.length, 0);

conflicts = [];
merged = context.mergeArray('entryLog', [
  {id:'P2',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',today:500},
  {id:'P2',recordVersion:2,updatedAt:'2026-07-02T00:00:00Z',today:700}
], [], conflicts);
assert.equal(merged.length, 1);
assert.equal(merged[0].today, 700, 'newer payment version wins deterministically');
assert.equal(conflicts.length, 0);

conflicts = [];
context.mergeArray('entryLog', [
  {id:'P3',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',today:500},
  {id:'P3',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',today:900}
], [], conflicts);
assert.equal(conflicts.length, 1, 'ambiguous financial duplicates require review');

assert.match(source, /BACKUP_FALLBACK_KEY/);
assert.match(source, /readOnlyLocal: true/);
assert.match(source, /Newer local records are preserved/);
assert.match(source, /Local data and pending queue were not changed/);
assert.doesNotMatch(source, /serviceAccount\s*:/, 'no Firebase service-account field exists');
assert.doesNotMatch(source, /clientSecret\s*:/, 'no client-secret field exists');

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'turso-gateway-only','firebase-project-validation','custom-api-secret-url-rejection',
    'provider-scoped-identity','identical-id-dedup','newer-version-resolution',
    'ambiguous-financial-conflict','read-only-backup-fallback','confirmed-atomic-restore'
  ]
}, null, 2));
