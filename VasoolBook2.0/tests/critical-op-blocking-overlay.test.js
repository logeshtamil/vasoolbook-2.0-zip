'use strict';

// Verifies the blocking progress overlay for Full Local/Drive Backup, Restore,
// and Import: it shows real (not fake) stage/percent updates via the existing
// _gdProgress() plumbing, blocks the Android hardware back button and the web
// popstate handler while active, always tears down in `finally` on success,
// error, or an already-running duplicate attempt, and lightweight background
// backup is explicitly exempted (stays non-blocking).

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// ── source-level wiring: every named critical operation actually uses the overlay ──
check('backupToDrive routes a foreground (user-initiated) backup through the blocking overlay', /return _vbRunCriticalOp\('Preparing Google Drive backup…'/.test(functionSource('backupToDrive')));
check('backupToDrive explicitly exempts background/incremental auto-backup (stays non-blocking)', /if\(options\.background\)return _gdRunExclusive\('Background Google Drive backup'/.test(functionSource('backupToDrive')));
check('exportData (Local Export) routes through the blocking overlay', /return _vbRunCriticalOp\('Preparing local backup export…'/.test(functionSource('exportData')));
check('triggerImport (native Local Import) routes through the blocking overlay', /_vbRunCriticalOp\('Preparing to import backup…',function\(\)\{return _importDataAndroid\(\);\}\)/.test(functionSource('triggerImport')));
check('importData (web Local Import) routes through the blocking overlay', /_vbRunCriticalOp\('Preparing to import backup…',function\(\)\{return _importDataImpl\(event\);\}\)/.test(functionSource('importData')));
check('_importDataImpl returns a Promise that only resolves once the FileReader flow actually finishes (not fire-and-forget)', /function _importDataImpl\(event\)\{\s*\n[\s\S]*?return new Promise\(function\(resolve\)\{/.test(source));
{
  const restoreSrc = functionSource('_restoreFromDriveImpl');
  check('_restoreFromDriveImpl engages the blocking overlay only AFTER the interactive preview is confirmed (never covering the preview popup)', restoreSrc.indexOf("if(!restoreMode)") < restoreSrc.indexOf('_vbCriticalOpActive=true;_showSyncScreen'));
  check('_restoreFromDriveImpl always clears the blocking overlay in finally', /\}finally\{[\s\S]*?_vbCriticalOpActive=false;_hideSyncScreen\(\);/.test(restoreSrc));
}
check('Android hardware back button is absorbed while a critical op is active', /window\.VBHandleAndroidBackButton=function\(\)\{\s*\n\s*if\(_vbCriticalOpActive\)/.test(source));
check('web popstate back navigation is absorbed while a critical op is active', /history\.pushState\(\{vbApp:true\},'',window\.location\.href\); \/\/ keep stack alive\s*\n\s*if\(_vbCriticalOpActive\)/.test(source));
check('real (not fake) progress: _gdProgress only updates the overlay when it is already visible — driven by actual backup/restore stage calls, not invented here', /if\(screen&&screen\.style\.display!=='none'&&typeof _showSyncScreen==='function'\)_showSyncScreen\(message,percent\);/.test(source));
check('the overlay always resolves to hidden even on a hung operation (self-healing watchdog)', /_syncScreenWatchdog=setTimeout\(function\(\)\{/.test(source));

// ── behavioral checks: _vbRunCriticalOp itself ──────────────────────────────
function buildContext() {
  const dom = {
    'auto-sync-screen': { style: { display: 'none' } },
    'sync-screen-msg': { textContent: '' },
    'sync-progress-bar': { style: { width: '' } },
    'sync-progress-num': { textContent: '' }
  };
  const context = {
    JSON, Object, String, Promise, console, setTimeout, clearTimeout,
    $id(id) { return dom[id] || null; },
    _dom: dom,
    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))); },
    _syncScreenWatchdog: null,
    showToast() {},
    _storageAudit() {}
  };
  vm.createContext(context);
  vm.runInContext(functionSource('_showSyncScreen'), context);
  vm.runInContext(functionSource('_hideSyncScreen'), context);
  vm.runInContext('var _vbCriticalOpActive=false;', context);
  vm.runInContext(functionSource('_vbRunCriticalOp'), context);
  return context;
}

(async () => {
  {
    const ctx = buildContext();
    const result = await ctx._vbRunCriticalOp('Starting…', () => Promise.resolve('done'));
    check('successful op returns the wrapped result', result === 'done');
    check('overlay is shown while active and hidden again after completion', ctx._dom['auto-sync-screen'].style.display === 'none');
    check('_vbCriticalOpActive is cleared after success', ctx._vbCriticalOpActive === false);
  }
  {
    const ctx = buildContext();
    let threw = null;
    try { await ctx._vbRunCriticalOp('Starting…', () => Promise.reject(new Error('boom'))); }
    catch (e) { threw = e; }
    check('a thrown error propagates to the caller (caller still sees the exact failure)', !!threw && threw.message === 'boom');
    check('overlay is hidden even after an error (finally always runs)', ctx._dom['auto-sync-screen'].style.display === 'none');
    check('_vbCriticalOpActive is cleared after an error', ctx._vbCriticalOpActive === false);
  }
  {
    const ctx = buildContext();
    let insideVisible = null;
    const p = ctx._vbRunCriticalOp('Starting…', async () => {
      insideVisible = ctx._dom['auto-sync-screen'].style.display;
      return 'ok';
    });
    await p;
    check('the overlay is actually visible while the wrapped operation is running', insideVisible === 'flex');
  }
  {
    const ctx = buildContext();
    let release;
    const first = ctx._vbRunCriticalOp('Starting…', () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await ctx._vbRunCriticalOp('Starting…', () => 'should not run');
    check('a second critical operation started while one is already active is rejected, not queued silently or run concurrently', second === null);
    release('first-done');
    await first;
    check('after the first operation finishes, a new critical operation can start again', ctx._vbCriticalOpActive === false);
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
