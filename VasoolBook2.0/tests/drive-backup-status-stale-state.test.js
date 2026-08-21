'use strict';

// Regression test for the "stuck Restore Required" Google Drive backup
// status bug.
//
// Root cause: _GD_SYNC_STATES.RESTORED was defined but never actually
// assigned by any code path, and _BK_GD_ST_KEY ('cm_bk_gd_status') was only
// ever set to 'ok' by the BACKUP flow, never by the RESTORE flow. A device
// that went empty -> Drive-history-detected -> "Restore Required", then
// successfully restored, had no code path that ever cleared the Restore
// Required state or marked the Drive relationship healthy again — the stale
// flags (Backup Health = "Restore required", Drive State = "Restore
// Required", Safe to Update = No) just sat in localStorage forever, across
// every render and every restart, even though the restore had genuinely
// succeeded and local data now matched Drive exactly.
//
// Fix: _gdReconcileStaleDriveStatus() recomputes Sync State / Backup Health
// from the ACTUAL current integrity signals (Pending Changes, Upload Queue,
// local-dirty flag, and a genuinely successful backup OR restore) every time
// the status panel renders (which already happens after every restore and on
// every restart) — never from the stale cached flag alone.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

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

function makeLocalStorage() {
  const store = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store,
  };
}

function freshContext() {
  const localStorage = makeLocalStorage();
  const context = {
    Object, String, Boolean,
    localStorage,
    _VB_IDB_MARKER_PREFIX: 'idbfallback_',
    _vbIdbSet: () => Promise.resolve(true),
    _isLocalDirty: () => localStorage.getItem('cm_local_dirty') === '1',
    // constants normally declared as top-level `var` in index.html
    _BK_GD_TS_KEY: 'cm_bk_gd_ts', _BK_GD_ST_KEY: 'cm_bk_gd_status', _BK_GD_MSG_KEY: 'cm_bk_gd_msg', _BK_GD_SZ_KEY: 'cm_bk_gd_size',
    _RS_GD_TS_KEY: 'cm_rs_gd_ts', _RS_GD_MSG_KEY: 'cm_rs_gd_msg',
    _GD_SYNC_STATE_KEY: 'cm_gd_sync_state_v1',
    _GD_SYNC_STATES: { FRESH: 'Fresh Local', REQUIRED: 'Restore Required', RESTORED: 'Restored', NORMAL: 'Normal Sync' },
  };
  vm.createContext(context);
  ['_safeSetItem', '_gdGetSyncState', '_gdSafeToUpdateStatus', '_gdReconcileStaleDriveStatus']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

// ── 1. The exact reported bug scenario: fresh-install-then-restore left the
//    device stuck in "Restore Required" / "Restore required" health forever,
//    even though the restore succeeded and everything is now clean.
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem('cm_gd_backup_health', 'Restore required');
  ls.setItem(ctx._BK_GD_ST_KEY, 'never'); // this device has never itself run a backup, only a restore
  ls.setItem(ctx._RS_GD_TS_KEY, '2026-08-19T10:00:00.000Z');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restored v5 — +120 new / 0 updated borrowers, +840 new entries');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '0');
  ls.setItem('cm_local_dirty', '0');

  ctx._gdReconcileStaleDriveStatus();

  assert.strictEqual(ls.getItem(ctx._GD_SYNC_STATE_KEY), 'Normal Sync', 'Drive State is cleared to Normal Sync (mapped to "Up to date")');
  assert.strictEqual(ls.getItem('cm_gd_backup_health'), 'Recovery key not exported', 'Backup Health is recalculated (no recovery key saved in this fixture)');
  assert.strictEqual(ls.getItem(ctx._BK_GD_ST_KEY), 'ok', 'a verified restore alone marks the Drive relationship healthy (Sync Status = Synced)');
  assert.strictEqual(ctx._gdSafeToUpdateStatus().safe, true, 'Safe to Update becomes Yes once state is genuinely clean');

  // With a recovery key already saved, health goes fully to Healthy.
  ls.setItem('cm_gd_recovery_key_saved', '1');
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem('cm_gd_backup_health', 'Restore required');
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls.getItem('cm_gd_backup_health'), 'Healthy', 'Backup Health = Healthy when a recovery key is already saved');
}

// ── 2. Must NOT clear a genuinely-required state: real pending changes.
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem('cm_gd_backup_health', 'Restore required');
  ls.setItem(ctx._RS_GD_TS_KEY, '2026-08-19T10:00:00.000Z');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restored v5 — +120 new / 0 updated borrowers, +840 new entries');
  ls.setItem('cm_gd_pending_changes', 'Pending'); // real pending changes exist
  ls.setItem('cm_gd_upload_queue', '0');
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls.getItem(ctx._GD_SYNC_STATE_KEY), 'Restore Required', 'a real pending-changes gap must never be papered over');
  assert.strictEqual(ls.getItem('cm_gd_backup_health'), 'Restore required', 'health stays Restore required while pending changes remain');
}

// ── 3. Must NOT clear when the upload queue is non-empty.
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem(ctx._RS_GD_TS_KEY, '2026-08-19T10:00:00.000Z');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restored v5 — +120 new / 0 updated borrowers, +840 new entries');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '2');
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls.getItem(ctx._GD_SYNC_STATE_KEY), 'Restore Required', 'a non-empty upload queue must never be papered over');
}

// ── 4. Must NOT clear when local data is dirty (changed since restore/backup).
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem(ctx._RS_GD_TS_KEY, '2026-08-19T10:00:00.000Z');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restored v5 — +120 new / 0 updated borrowers, +840 new entries');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '0');
  ls.setItem('cm_local_dirty', '1');
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls.getItem(ctx._GD_SYNC_STATE_KEY), 'Restore Required', 'locally-dirty data must never be papered over — local must genuinely match the verified snapshot');
}

// ── 5. Must NOT clear for a FAILED restore, and must NOT clear for a restore
//    that completed WITH INTEGRITY WARNINGS (not a clean verified success).
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restore failed: network timeout');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '0');
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls.getItem(ctx._GD_SYNC_STATE_KEY), 'Restore Required', 'a failed restore must never be treated as verified');

  const ctx2 = freshContext();
  const ls2 = ctx2.localStorage;
  ls2.setItem(ctx2._GD_SYNC_STATE_KEY, 'Restore Required');
  ls2.setItem(ctx2._RS_GD_MSG_KEY, 'Restored WITH INTEGRITY WARNINGS v5 — +120 new borrowers');
  ls2.setItem('cm_gd_pending_changes', '0');
  ls2.setItem('cm_gd_upload_queue', '0');
  ctx2._gdReconcileStaleDriveStatus();
  assert.strictEqual(ls2.getItem(ctx2._GD_SYNC_STATE_KEY), 'Restore Required', 'a restore with integrity warnings is not treated as a clean verified restore');
}

// ── 6. Idempotent across repeated calls (simulates restart: the app re-runs
//    this on every render, including at startup) — no flip-flopping.
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Restore Required');
  ls.setItem(ctx._RS_GD_TS_KEY, '2026-08-19T10:00:00.000Z');
  ls.setItem(ctx._RS_GD_MSG_KEY, 'Restored v5 — +120 new / 0 updated borrowers, +840 new entries');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '0');
  ctx._gdReconcileStaleDriveStatus();
  const after1 = { state: ls.getItem(ctx._GD_SYNC_STATE_KEY), health: ls.getItem('cm_gd_backup_health'), st: ls.getItem(ctx._BK_GD_ST_KEY) };
  ctx._gdReconcileStaleDriveStatus(); // simulated restart / second render
  ctx._gdReconcileStaleDriveStatus();
  const after3 = { state: ls.getItem(ctx._GD_SYNC_STATE_KEY), health: ls.getItem('cm_gd_backup_health'), st: ls.getItem(ctx._BK_GD_ST_KEY) };
  assert.deepStrictEqual(after1, after3, 'repeated calls (restart) are idempotent, no flip-flopping');
  assert.strictEqual(after3.state, 'Normal Sync');
}

// ── 7. Already-healthy state (nothing stale) is left completely untouched —
//    the function only ever corrects a genuinely stale flag.
{
  const ctx = freshContext();
  const ls = ctx.localStorage;
  ls.setItem(ctx._GD_SYNC_STATE_KEY, 'Normal Sync');
  ls.setItem('cm_gd_backup_health', 'Healthy');
  ls.setItem(ctx._BK_GD_ST_KEY, 'ok');
  ls.setItem('cm_gd_pending_changes', '0');
  ls.setItem('cm_gd_upload_queue', '0');
  const before = JSON.stringify(ls._store);
  ctx._gdReconcileStaleDriveStatus();
  assert.strictEqual(JSON.stringify(ls._store), before, 'an already-correct state is never rewritten');
}

// ── 8. Source-level safety checks: never triggers another restore, never
//    touches financial data/records.
{
  const fnSource = extractFunction('_gdReconcileStaleDriveStatus');
  assert.ok(!/restoreFromDrive|_restoreFromDriveImpl|_gdApplyBackupData|_vbApplyBackupData/.test(fnSource), 'never triggers a restore or data-apply operation');
  assert.ok(!/borrowers|entryLog|customers|areas\[|principalAmt|loanAmt/.test(fnSource), 'never touches financial/record data — status keys only');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'stuck-restore-required-cleared-after-verified-restore',
    'healthy-when-recovery-key-saved',
    'real-pending-changes-not-cleared',
    'nonempty-upload-queue-not-cleared',
    'dirty-local-data-not-cleared',
    'failed-restore-not-treated-as-verified',
    'integrity-warning-restore-not-treated-as-clean',
    'idempotent-across-restart',
    'already-healthy-state-untouched',
    'never-triggers-restore-or-touches-financial-data',
  ],
}, null, 2));
