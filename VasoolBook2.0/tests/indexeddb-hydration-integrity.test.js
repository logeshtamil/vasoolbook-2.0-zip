'use strict';

// Verifies the boot-time localStorage/IndexedDB reconciliation (_verifyAndHydrateFromIndexedDB)
// never resurrects a tombstoned (deleted) record just because a stale IndexedDB snapshot
// still contains it with a higher raw count — it must merge per-record using deterministic
// content hashes + tombstones, not swap whole arrays based on count/size alone.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const VBSqliteCore = require('../www/js/vasoolbook-sqlite-core.js');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
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

function varSource(name) {
  const re = new RegExp('var ' + name + '\\s*=\\s*[^;]+;');
  const m = source.match(re);
  assert.ok(m, name + ' must exist');
  return m[0];
}

function makeLocalStorage() {
  const store = Object.create(null);
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _dump: () => Object.assign({}, store)
  };
}

function financialFingerprint(kind, row) { return VBSqliteCore.financialRecordFingerprint(kind, row, 0); }

async function run(scenario) {
  const localStorage = makeLocalStorage();
  const context = {
    JSON, Object, Array, String, Number, Math, console,
    window: {}, // window.VBSqliteCore is set below
    localStorage,
    customers: scenario.current.customers || [],
    borrowers: scenario.current.borrowers || [],
    entryLog: scenario.current.entryLog || [],
    areas: scenario.current.areas || [],
    nonAccTxns: scenario.current.nonAccTxns || [],
    upiIds: scenario.current.upiIds || [],
    _vbTombstones: scenario.current.tombstones || [],
    S: {}, CFG_DEF: {},
    _storageAudit(...args) { context._audit.push(args); },
    _audit: [],
    _fullUIRefreshCalls: 0,
    _fullUIRefresh() { context._fullUIRefreshCalls += 1; },
    _migrateInterestCycleAllocationMetadata() { return { changed: false }; },
    syncAllBorrowerBalancesFromHistory() { return true; },
    saveStateFastCalls: 0,
    saveStateFast() { context.saveStateFastCalls += 1; },
    _vbIdbGetMany(keys) {
      const vals = {};
      keys.forEach(k => { if (k in scenario.idb) vals[k] = JSON.stringify(scenario.idb[k]); });
      return Promise.resolve(vals);
    }
  };
  context.window.VBSqliteCore = VBSqliteCore;
  vm.createContext(context);
  vm.runInContext(varSource('_VB_IDB_MARKER_PREFIX'), context);
  vm.runInContext(varSource('_VB_TOMBSTONE_KEY'), context);
  vm.runInContext(functionSource('_vbChecksum'), context);
  vm.runInContext(functionSource('_verifyAndHydrateFromIndexedDB'), context);
  // varSource above only grabs _VB_HYDRATE_KIND's declaration line if matched separately;
  // it is declared immediately before the function in index.html, so pull it too.
  vm.runInContext(varSource('_VB_HYDRATE_KIND'), context);

  await new Promise(resolve => {
    context._verifyAndHydrateFromIndexedDB(scenario.forceCheck !== false);
    // _verifyAndHydrateFromIndexedDB resolves internally via a Promise chain (_vbIdbGetMany().then(...)),
    // which is already resolved synchronously by our stub — flush microtasks before asserting.
    setTimeout(resolve, 0);
  });
  return context;
}

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── Scenario 1: stale IndexedDB has MORE records (a raw record deleted+tombstoned in
  // the current/localStorage state never made it into IndexedDB before a crash). The old
  // count-only logic ("IDB count > local count -> trust IDB wholesale") would resurrect
  // the deleted borrower. The tombstone-aware merge must not.
  {
    const survivor = { id: 'b-keep', name: 'Keep', updatedAt: '2026-08-01T00:00:00.000Z' };
    const deleted = { id: 'b-deleted', name: 'Deleted', updatedAt: '2026-07-01T00:00:00.000Z' };
    const legitNew = { id: 'b-new', name: 'New', updatedAt: '2026-08-10T00:00:00.000Z' }; // exists only in current (created after the stale IDB snapshot)
    const ctx = await run({
      current: {
        borrowers: [survivor, legitNew],
        tombstones: [{ kind: 'borrowers', key: 'id:b-deleted', revision: 1, deletedAt: '2026-08-05T00:00:00.000Z' }]
      },
      idb: { cm_b: [survivor, deleted] } // stale: 2 records, current has 2 records too (equal count) but content differs
    });
    const ids = ctx.borrowers.map(b => b.id).sort();
    check('tombstoned record is never resurrected from a stale IndexedDB snapshot',
      ids.indexOf('b-deleted') === -1, JSON.stringify(ids));
    check('legitimately-created record (absent from stale IndexedDB) is preserved',
      ids.indexOf('b-new') >= 0, JSON.stringify(ids));
    check('survivor record present in both sides is preserved',
      ids.indexOf('b-keep') >= 0, JSON.stringify(ids));
  }

  // ── Scenario 2: equal-count delete+create. Current: deleted A (tombstoned), created C.
  // Stale IndexedDB: still has A, never got C. Raw counts are EQUAL (1 vs 1) so a naive
  // count comparison sees "no difference" and might skip reconciliation OR (if it swapped
  // on any mismatch) blindly replace with the wrong equal-count snapshot. The hash-based
  // check must detect the content actually differs and resolve to the correct set.
  {
    const recordA = { id: 'e-A', bid: 'loan-1', today: 500, date: '2026-08-01', updatedAt: '2026-08-01T00:00:00.000Z' };
    const recordC = { id: 'e-C', bid: 'loan-1', today: 700, date: '2026-08-12', updatedAt: '2026-08-12T00:00:00.000Z' };
    const ctx = await run({
      current: {
        entryLog: [recordC],
        tombstones: [{ kind: 'entryLog', key: 'id:e-A', revision: 1, deletedAt: '2026-08-11T00:00:00.000Z' }]
      },
      idb: { cm_l: [recordA] } // equal count (1 vs 1), completely different content
    });
    const ids = ctx.entryLog.map(e => e.id).sort();
    check('equal-count delete+create: tombstoned old record excluded despite equal raw counts',
      ids.indexOf('e-A') === -1, JSON.stringify(ids));
    check('equal-count delete+create: new record retained despite equal raw counts',
      ids.indexOf('e-C') >= 0 && ids.length === 1, JSON.stringify(ids));
  }

  // ── Scenario 3: IndexedDB is legitimately ahead (localStorage lagged/cleared) — the
  // recovery capability itself must still work; this is not a regression test for
  // "never trust IndexedDB", only for "never trust it blindly over a tombstone".
  {
    const onlyInIdb = { id: 'c-recovered', name: 'Recovered Customer', updatedAt: '2026-08-01T00:00:00.000Z' };
    const ctx = await run({
      current: { customers: [] },
      idb: { cm_c: [onlyInIdb] }
    });
    check('legitimate IndexedDB-ahead recovery still works', ctx.customers.some(c => c.id === 'c-recovered'), JSON.stringify(ctx.customers));
    check('recovery persists via saveStateFast, not left in memory only', ctx.saveStateFastCalls === 1);
  }

  // ── Scenario 4: nothing actually differs (by content hash) — must not thrash a save/render
  // cycle on every boot just because forceCheck was set.
  {
    const same = { id: 'b-same', name: 'Same', updatedAt: '2026-08-01T00:00:00.000Z' };
    const ctx = await run({ current: { borrowers: [same] }, idb: { cm_b: [same] } });
    check('identical content does not trigger a spurious hydrate/save/re-render', ctx.saveStateFastCalls === 0 && ctx._fullUIRefreshCalls === 0);
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
