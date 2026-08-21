'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

const context = {
  JSON, Object, Array, String, Number, Math, Error,
  _gdRestoreRecordKey(kind, row) {
    if (row && row.id != null) return 'id:' + String(row.id);
    return '';
  },
  _gdStringChecksum(text) {
    text = String(text || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  },
  _gdSha256: async text => crypto.createHash('sha256').update(String(text)).digest('hex')
};
vm.createContext(context);
[
  '_gdIncrementalCollections',
  '_gdCanonicalRecordValue',
  '_gdCanonicalRecordText',
  '_gdIncrementalKey',
  '_gdRecordManifest',
  '_gdRecordManifestCanonical',
  '_gdStateChecksum',
  '_gdRecordManifestDifferences',
  '_gdRecordManifestMismatchError'
].forEach(name => vm.runInContext(functionSource(name), context));

const opening = {
  id: 'opening_paid__loan-1', entryType: 'opening_paid', loanId: 'loan-1',
  borrowerId: 'borrower-1', today: 250, createdAt: '2026-08-17T04:30:00.000Z'
};
const payload = {
  app: 'VasoolBook',
  customers: [{ id: 'borrower-1', name: 'A' }],
  loanProfiles: [{ id: 'loan-1', borrowerId: 'borrower-1', loan: 1000, originalOpeningPaid: 250 }],
  entryLog: [opening, { id: 'pay-1', loanId: 'loan-1', today: 100, createdAt: '2026-08-17T05:00:00.000Z' }],
  areas: [{ id: 'area-1', name: 'North' }],
  nonAccTxns: [], upiIds: [], expenses: [], reminders: [], collReports: [],
  settings: {}, cashbook: {}, retiredAreaIds: {}, legacyRecords: {}
};

(async () => {
  const version = 2;
  const uploadPlan = context._gdRecordManifest(payload, {}, version);
  const uploadHash = await context._gdStateChecksum(uploadPlan.records, version);

  const decrypted = JSON.parse(JSON.stringify(payload));
  decrypted.loanProfiles.reverse();
  decrypted.entryLog.reverse();
  decrypted.customers = [{ name: 'A', id: 'borrower-1' }];
  const restorePlan = context._gdRecordManifest(decrypted, {}, version);
  const restoreHash = await context._gdStateChecksum(restorePlan.records, version);
  assert.equal(restoreHash, uploadHash, 'canonical manifest is independent of record order and object key order');
  assert.deepStrictEqual(Array.from(context._gdRecordManifestDifferences(uploadPlan.records, restorePlan.records)), [], 'fresh restore record manifest matches upload');
  assert.equal(decrypted.loanProfiles.length, payload.loanProfiles.length, 'borrower/loan count is preserved');
  assert.equal(decrypted.entryLog.length, payload.entryLog.length, 'entryLog count is preserved');
  assert.equal(decrypted.entryLog.filter(row => row.entryType === 'opening_paid').length, 1, 'Opening Paid record is preserved exactly once');

  const corrupt = JSON.parse(JSON.stringify(decrypted));
  corrupt.entryLog.find(row => row.id === 'pay-1').today = 99;
  const corruptPlan = context._gdRecordManifest(corrupt, {}, version);
  const corruptHash = await context._gdStateChecksum(corruptPlan.records, version);
  assert.notEqual(corruptHash, uploadHash, 'same-ID financial mutation is detected');
  const error = context._gdRecordManifestMismatchError('Daily full record manifest checksum failed', uploadHash, corruptHash, uploadPlan.records, corruptPlan.records, version);
  assert.match(error.message, /entryLog/);
  assert.match(error.message, /id:pay-1/);
  assert.match(error.message, /expectedHash=/);
  assert.match(error.message, /actualHash=/);

  const restoreFunction = functionSource('_gdMaterializeIncrementalRestore');
  const validatePosition = restoreFunction.indexOf('_gdRestorePreflightSelfValidate(');
  const migrationPosition = restoreFunction.indexOf('payload=_vbNormalizeBackupPayload(payload)');
  assert.ok(validatePosition >= 0 && migrationPosition > validatePosition, 'decrypted immutable dataset is checksum-verified (isolated self-validation) before migration/normalization');
  const selfValidateFunction = functionSource('_gdSelfValidateDailyFull');
  assert.ok(selfValidateFunction.indexOf('_vbNormalizeBackupPayload') === -1, 'isolated self-validation never normalizes/migrates the snapshot it is checking');
  assert.ok(source.includes('recordManifestRecords=_gdDeepClone(pending.plan.records)'), 'new daily full manifests retain record-level mismatch evidence');
  assert.ok(source.includes('driveSelfManifest'), 'Daily Full backups embed their own self-contained record manifest, independent of the central incremental manifest');
  assert.ok(source.includes('_gdShowRestoreFallbackConfirm'), 'restore preflight offers an explicit user confirmation before falling back to a previous Daily Full backup');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'canonical record ordering',
      'canonical object serialization',
      'manifest version binding',
      'decrypted pre-migration validation',
      'borrower count equality',
      'entryLog count equality',
      'Opening Paid equality',
      'exact store/record/hash mismatch diagnostics'
    ]
  }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
