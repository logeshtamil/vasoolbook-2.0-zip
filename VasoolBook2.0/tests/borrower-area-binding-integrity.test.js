'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const areas = [
  { areaId: '1001', name: 'North', areaType: 'main' },
  { areaId: '101', name: 'North One', areaType: 'sub', parentAreaId: '1001', parentArea: 'North' }
];
const borrowers = [
  { id: 'legacy-main', area: 'North', areaId: '' },
  { id: 'stable-sub', area: 'North One', areaId: '101', mainArea: 'North', mainAreaId: '1001' }
];
const beforeAudit = JSON.stringify(borrowers);
const context = {
  borrowers,
  window: {},
  _storageAudit: () => {},
  _findAreaById: id => areas.find(area => area.areaId === id) || null,
  _areaName: area => area ? area.name : '',
  _areaId: area => area ? area.areaId : '',
  _mainAreaObjFor: area => area && area.parentAreaId ? areas.find(item => item.areaId === area.parentAreaId) : area
};
vm.createContext(context);
vm.runInContext(extractFunction('_auditBorrowerAreaBindings'), context);
const audit = context._auditBorrowerAreaBindings('test');
assert.equal(audit.missingAreaId.length, 1, 'legacy main-area assignment is flagged instead of reassigned');
assert.equal(JSON.stringify(borrowers), beforeAudit, 'audit never mutates borrower records');

context._applyBorrowerAreaBinding = () => { throw new Error('legacy binding must not be auto-applied'); };
vm.runInContext(extractFunction('_preserveBorrowerAreaBindings'), context);
const merged = [{ id: 'legacy-main', area: 'North', areaId: '' }];
context._preserveBorrowerAreaBindings([], merged, 'import');
assert.deepEqual(merged, [{ id: 'legacy-main', area: 'North', areaId: '' }], 'import leaves name-only assignment unchanged');

const incoming = [{ id: 'stable-sub', area: 'Other Area', areaId: '202' }];
const result = context._preserveBorrowerAreaBindings([borrowers[1]], incoming, 'restore');
assert.equal(result.preserved, 1);
assert.equal(incoming[0].areaId, '101', 'restore cannot overwrite a saved borrower area ID');
assert.equal(incoming[0].area, 'North One');

const migrate = extractFunction('migrateAreaData');
const ensure = extractFunction('ensureAreaIds');
assert.ok(!/children\.length===1/.test(migrate), 'migration no longer selects the only child sub-area');
assert.ok(!/stamp\(borrowers\)/.test(ensure), 'area normalization never rewrites borrower bindings');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'single-sub-area-does-not-reassign-borrower',
    'audit-is-read-only',
    'import-keeps-name-only-legacy-area',
    'restore-protects-existing-area-id',
    'normalization-does-not-overwrite-borrowers'
  ]
}, null, 2));
