'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
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

const areas = [
    { areaId: '1000', name: 'MAIN A', areaType: 'main' },
    { areaId: '101', name: 'SUB A', areaType: 'sub', parentAreaId: '1000' },
    { areaId: '102', name: 'SUB B', areaType: 'sub', parentAreaId: '1000' },
    { areaId: '103', name: 'DUPLICATE', areaType: 'sub', parentAreaId: '1000' },
    { areaId: '104', name: 'DUPLICATE', areaType: 'sub', parentAreaId: '1000' }
];
const context = {
  areas,
  _normArea: value => String(value || '').trim().replace(/\s+/g, ' '),
  _areaId: area => area && area.areaId ? String(area.areaId) : '',
  _areaName: area => typeof area === 'string' ? area.trim() : String((area && area.name) || '').trim(),
  _findAreaById: id => areas.find(area => area.areaId === String(id)) || null,
  _mainAreaObjFor: area => {
    if (!area) return null;
    if (area.areaType !== 'sub') return area;
    return areas.find(item => item.areaId === area.parentAreaId) || null;
  },
  _storageAudit() {},
  Date
};
vm.createContext(context);
[
  '_findUniqueAreaByName', '_borrowerAreaBinding', '_applyBorrowerAreaBinding',
  '_preserveBorrowerAreaBindings'
].forEach(name => vm.runInContext(extractFunction(name), context));

const original = { id: 'B-1', areaId: '101', area: 'SUB A', mainAreaId: '1000', mainArea: 'MAIN A' };
const incoming = { id: 'B-1', areaId: '102', area: 'SUB B', mainAreaId: '1000', mainArea: 'MAIN A' };
const report = context._preserveBorrowerAreaBindings([original], [incoming], 'test-import');
assert.equal(report.preserved, 1, 'restore preserves existing borrower binding by borrower ID');
assert.equal(incoming.areaId, '101');
assert.equal(incoming.area, 'SUB A');

const stale = { id: 'B-2', areaId: '101', area: 'SUB A' };
const otherArea = context._borrowerAreaBinding({ areaId: '102' });
assert.equal(context._applyBorrowerAreaBinding(stale, otherArea, false), false, 'stale UI cannot change a locked borrower area');
assert.equal(stale.areaId, '101');
assert.equal(context._applyBorrowerAreaBinding(stale, otherArea, true), true, 'explicit borrower edit can change area');
assert.equal(stale.areaId, '102');

assert.equal(context._findUniqueAreaByName('DUPLICATE'), null, 'ambiguous legacy area names never map to an arbitrary area');
assert.equal(context._borrowerAreaBinding({ area: 'DUPLICATE' }), null, 'ambiguous legacy borrower area remains unresolved for audit');

const updateCustomer = extractFunction('updateCustomerDetails');
assert.ok(!updateCustomer.includes('borrowers[i].area=extra.area'), 'customer updates do not cascade area to every loan');
assert.ok(!updateCustomer.includes('borrowers[i].areaId=extra.areaId'), 'customer updates do not cascade area IDs to every loan');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'borrower-id-area-lock',
    'explicit-area-edit-only',
    'restore-area-preservation',
    'duplicate-name-no-cross-map',
    'customer-update-no-cross-loan-area-copy'
  ]
}, null, 2));
