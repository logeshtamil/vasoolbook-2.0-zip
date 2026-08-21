'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');
const sqliteSource = fs.readFileSync('www/js/sqliteDataIntegrity.js', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < source.length; i += 1) {
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

(async function () {
  const backing = new Map();
  const secure = new Map();
  const context = {
    Date, Math, JSON, Number, String, Promise, isFinite, Uint8Array, TextEncoder, atob, btoa,
    window: {
      crypto: crypto.webcrypto,
      VBSecureStorage: {
        getItem: key => JSON.stringify({status:'ok', value:secure.get(key) || ''}),
        setItem: (key, value) => { secure.set(key, value); return JSON.stringify({status:'ok'}); },
        removeItem: key => { secure.delete(key); return JSON.stringify({status:'ok'}); }
      }
    },
    localStorage: {
      getItem: key => backing.has(key) ? backing.get(key) : null,
      setItem: (key, value) => backing.set(key, String(value)),
      removeItem: key => backing.delete(key)
    },
    _getDeviceId: () => 'device-A',
    _gdSha256Fallback: text => crypto.createHash('sha256').update(text).digest('hex'),
    syncAudit: () => {}, cfg: () => 'Owner'
  };
  vm.createContext(context);
  vm.runInContext("var _MUM_USERS_KEY='cm_mum_users',_MUM_SESSION_KEY='cm_mum_session',_MUM_AUTH_VERSION_KEY='cm_mum_auth_version',_MUM_AUTH_VERSION=4,_MUM_SESSION_MS=28800000,_MUM_PIN_ITERATIONS=210000,_MUM_PIN_KDF='PBKDF2-SHA-256';", context);
  [
    '_mumGetUsers','_mumSaveUsers','_mumSecureBridge','_mumSecureRead','_mumSecureWrite','_mumSecureRemove',
    '_mumClearSession','_mumGetSession','_mumSaveSession','_mumB64','_mumB64Bytes','_mumCrypto','_mumSalt',
    '_mumSessionNonce','_mumCredentialValid','_mumRecoveryValid','_mumDeriveSecretHash','_mumDerivePinHash',
    '_mumConstantTimeEqual','_mumSetPin','_mumSetRecovery','_mumVerifyPin','_mumVerifyRecovery',
    '_mumNormalizeLoginId','_mumFindUserByLogin','_mumValidUsers','_mumMigrateUserRecords','_mumMigrateSecurity',
    '_mumSessionValid','_mumCurrentUser','_mumStartSession','_mumBootstrap','_mumAutoLogin'
  ].forEach(name => vm.runInContext(extractFunction(name), context));

  context._mumBootstrap();
  assert.equal(context._mumGetUsers().length, 0, 'fresh install has no default or blank Admin');
  assert.equal(context._mumGetSession(), null, 'fresh install has no session');

  const user = {userId:'U001', loginId:'owner_01', username:'owner_01', name:'Owner', role:'Admin', status:'active', deviceId:'device-A', sessionVersion:1};
  await context._mumSetPin(user, 'Secure987');
  await context._mumSetRecovery(user, '9876543210', 'Recover987');
  context._mumSaveUsers([user]);
  const storedText = backing.get('cm_mum_users');
  assert.ok(!storedText.includes('Secure987') && !storedText.includes('Recover987'), 'credential and recovery code are never stored in plaintext');
  assert.equal(context._mumValidUsers().length, 1, 'valid signup enables sign in');
  assert.equal(context._mumFindUserByLogin('OWNER_01').userId, 'U001', 'Login ID lookup is normalized');
  assert.equal(context._mumFindUserByLogin('U001').userId, 'U001', 'legacy User ID remains a compatible alias');
  assert.equal(await context._mumVerifyPin(user, 'Secure987'), true, 'correct password signs in');
  assert.equal(await context._mumVerifyPin(user, 'Wrong987'), false, 'wrong password is rejected');
  assert.equal(await context._mumVerifyRecovery(user, '9876543210', 'Recover987'), true, 'verified recovery succeeds');
  assert.equal(await context._mumVerifyRecovery(user, '9876543210', 'Wrong999'), false, 'wrong recovery code is rejected');
  assert.equal(await context._mumVerifyRecovery(null, '9876543210', 'Wrong999'), false, 'unknown account follows safe dummy verification');

  context._mumStartSession(user, 'restart-test');
  assert.equal(context._mumCurrentUser().userId, 'U001', 'valid device-bound session survives restart');
  const oldSession = context._mumGetSession();
  const oldHash = user.pinHash;
  await context._mumSetPin(user, 'Reset9876');
  user.sessionVersion += 1;
  context._mumSaveUsers([user]);
  assert.notEqual(user.pinHash, oldHash, 'reset derives a fresh credential hash');
  assert.equal(await context._mumVerifyPin(user, 'Secure987'), false, 'old credential is invalid after reset');
  assert.equal(await context._mumVerifyPin(user, 'Reset9876'), true, 'new credential works after reset');
  assert.equal(context._mumSessionValid(oldSession, user), false, 'reset invalidates stale sessions');

  context._mumClearSession();
  assert.equal(context._mumGetSession(), null, 'logout clears secure session');
  const beforeUpdate = JSON.stringify(context._mumGetUsers());
  await context._mumMigrateSecurity();
  assert.equal(JSON.stringify(context._mumGetUsers()), beforeUpdate, 'app update migration preserves current hashed user');

  backing.set('cm_mum_users', JSON.stringify([{userId:'U002',username:'legacy',name:'Legacy',role:'Collector',status:'active',pin:'5678',sessionVersion:1}]));
  await context._mumMigrateSecurity();
  const legacy = context._mumGetUsers()[0];
  assert.equal(legacy.loginId, 'legacy', 'legacy Login ID is migrated');
  assert.ok(legacy.pinHash && !Object.prototype.hasOwnProperty.call(legacy, 'pin'), 'legacy plaintext PIN is safely migrated and removed');
  assert.equal(await context._mumVerifyPin(legacy, '5678'), true, 'existing user remains usable after migration');

  assert.match(source, /First-Time Setup \/ Sign Up/, 'first-time signup UI exists');
  assert.match(source, /Forgot Login ID/, 'forgot Login ID option exists');
  assert.match(source, /Forgot Password \/ PIN/, 'forgot Password/PIN option exists');
  assert.match(source, /Recovery details could not be verified\. Contact an Admin for reset access\./, 'recovery failure is generic');
  assert.match(source, /mumResetUserAccess/, 'Admin-controlled reset exists');
  assert.match(source, /_MUM_AUTH_MAX_FAILURES=5/, 'authentication throttling is configured');
  assert.doesNotMatch(extractFunction('_mumBootstrap'), /username:\s*'admin'/, 'no default Admin or auto-login identity remains');
  assert.match(sqliteSource, /session:null/, 'backup capture excludes runtime sessions');
  assert.match(sqliteSource, /k!==['"]cm_mum_session['"]/, 'legacy backup payload excludes runtime session key');
  assert.match(sqliteSource, /k!==['"]cm_mum_auth_throttle['"]/, 'legacy backup payload excludes authentication throttle state');
  assert.doesNotMatch(sqliteSource, /_mumSaveSession\(s\.session\)/, 'restore cannot activate a backed-up session');

  console.log(JSON.stringify({status:'PASS', checks:[
    'fresh-install-signup','no-default-admin','hashed-password-pin','hashed-recovery','login-id-signin',
    'wrong-credential','forgot-id-verification','forgot-password-reset','admin-reset','logout','restart',
    'app-update-migration','backup-session-exclusion','stale-session-invalidation','enumeration-safe-failure'
  ]}, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
