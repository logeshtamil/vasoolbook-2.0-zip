'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');
function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, name + ' exists');
  let i = source.indexOf('{', match.index), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

(async function () {
  const backing = new Map();
  const webCrypto = crypto.webcrypto;
  const context = {
    Date, Math, JSON, isFinite, Uint8Array, TextEncoder, atob, btoa,
    window: { crypto: webCrypto },
    localStorage: { getItem:k => backing.has(k) ? backing.get(k) : null, setItem:(k,v) => backing.set(k, String(v)), removeItem:k => backing.delete(k) },
    _getDeviceId: () => 'device-A', cfg: () => 'Owner',
    _gdSha256Fallback: text => crypto.createHash('sha256').update(text).digest('hex'),
    syncAudit: () => {}, showToast: () => {}, setTimeout: () => {}, document: { getElementById: () => null }
  };
  vm.createContext(context);
  vm.runInContext("var _MUM_USERS_KEY='cm_mum_users',_MUM_SESSION_KEY='cm_mum_session',_MUM_AUTH_VERSION_KEY='cm_mum_auth_version',_MUM_AUTH_VERSION=4,_MUM_SESSION_MS=28800000,_MUM_PIN_ITERATIONS=210000,_MUM_PIN_KDF='PBKDF2-SHA-256';", context);
  ['_mumGetUsers','_mumSaveUsers','_mumSecureBridge','_mumSecureRead','_mumSecureWrite','_mumSecureRemove','_mumClearSession','_mumGetSession','_mumSaveSession','_mumB64','_mumB64Bytes','_mumCrypto','_mumSalt','_mumSessionNonce','_mumCredentialValid','_mumRecoveryValid','_mumDeriveSecretHash','_mumDerivePinHash','_mumConstantTimeEqual','_mumSetPin','_mumVerifyPin','_mumNormalizeLoginId','_mumMigrateUserRecords','_mumMigrateSecurity','_mumSessionValid','_mumCurrentUser','_mumIsAdmin','_mumStartSession','_mumBootstrap','_mumAutoLogin'].forEach(name => vm.runInContext(extractFunction(name), context));

  context._mumBootstrap();
  let users = context._mumGetUsers();
  assert.equal(users.length, 0, 'fresh install creates no implicit owner record');
  assert.equal(context._mumGetSession(), null, 'fresh install is never auto-authenticated');

  backing.clear();
  context._mumSaveUsers([{ userId:'U001', username:'admin', name:'Legacy Admin', role:'Admin', status:'active', pin:'1234', deviceId:'device-A' }]);
  await context._mumMigrateSecurity(); users = context._mumGetUsers();
  assert.equal(users[0].pinKdf, 'PBKDF2-SHA-256', 'legacy plaintext PIN migrates to PBKDF2');
  assert.ok(users[0].pinHash && users[0].pinSalt && users[0].pinIterations >= 210000, 'migrated record has salted slow-hash metadata');
  assert.ok(!Object.prototype.hasOwnProperty.call(users[0], 'pin'), 'legacy plaintext PIN is removed');
  assert.equal(await context._mumVerifyPin(users[0], '1234'), true, 'migrated user can authenticate');
  assert.equal(await context._mumVerifyPin(users[0], '9999'), false, 'wrong PIN is rejected');
  context._mumAutoLogin();
  assert.equal(context._mumCurrentUser(), null, 'a sole existing user is not silently auto-logged in');

  context._mumStartSession(users[0], 'test');
  assert.equal(context._mumIsAdmin(), true, 'valid bound Admin session authorizes Admin action');
  const secureBacking = new Map();
  context.window.VBSecureStorage = {
    getItem:k => JSON.stringify({status:'ok',value:secureBacking.get(k)||''}),
    setItem:(k,v) => { secureBacking.set(k,v); return JSON.stringify({status:'ok'}); },
    removeItem:k => { secureBacking.delete(k); return JSON.stringify({status:'ok'}); }
  };
  context._mumStartSession(users[0], 'keystore-test');
  assert.ok(secureBacking.get('cm_mum_session'), 'Android bridge receives the session');
  assert.equal(backing.has('cm_mum_session'), false, 'Android session is not mirrored to plaintext localStorage');
  const oldHash = users[0].pinHash; await context._mumSetPin(users[0], '4321'); context._mumSaveUsers(users);
  assert.notEqual(users[0].pinHash, oldHash, 'PIN change derives a new hash');
  assert.equal(await context._mumVerifyPin(users[0], '4321'), true, 'changed PIN authenticates');
  assert.equal(await context._mumVerifyPin(users[0], '1234'), false, 'old PIN is rejected after change');
  users.push({ userId:'U002', username:'collector', name:'Collector', role:'Collector', status:'active', deviceId:'device-A', sessionVersion:1 });
  await context._mumSetPin(users[1], '5678'); context._mumSaveUsers(users); context._mumStartSession(users[1], 'test');
  assert.equal(context._mumIsAdmin(), false, 'authenticated non-Admin is denied Admin actions');
  context._mumStartSession(users[0], 'test');
  let session = context._mumGetSession(); session.deviceId = 'device-B'; context._mumSaveSession(session);
  assert.equal(context._mumCurrentUser(), null, 'session hijack from another device is rejected');
  context._mumStartSession(users[0], 'test'); session = context._mumGetSession(); session.expiresAt = '2000-01-01T00:00:00.000Z'; context._mumSaveSession(session);
  assert.equal(context._mumCurrentUser(), null, 'expired session is rejected');

  assert.match(source, /name:'PBKDF2'/, 'Web Crypto PBKDF2 is used');
  assert.match(source, /_MUM_PIN_ITERATIONS=210000/, 'slow KDF iteration count is configured');
  assert.match(source, /window\.VBSecureStorage/, 'Android Keystore bridge is used for sessions when available');
  assert.match(source, /First-Time Setup \/ Sign Up/, 'fresh install renders explicit signup');
  assert.match(source, /Forgot Login ID/, 'forgot Login ID flow is available');
  assert.match(source, /Forgot Password \/ PIN/, 'forgot credential flow is available');
  assert.doesNotMatch(extractFunction('_mumBootstrap'), /username:\s*'admin'/, 'bootstrap has no default Admin identity');
  assert.match(source, /async function mumSaveUser\(\)/, 'create/change flow awaits secure derivation');
  assert.match(source, /if\(!_mumIsAdmin\(\)\)\{showToast\('Admin sign-in required'\);_mumShowAuthGate\(\);return;\}/, 'Admin manager is deny-by-default');
  assert.doesNotMatch(source, /_mumSaveSession\(\{userId:adminId,loginTime/, 'old blank-PIN bootstrap session is removed');
  console.log(JSON.stringify({ status:'PASS', checks:['first-run-no-auto-login','PBKDF2-migration','plaintext-pin-removal','create-login-change','wrong-pin-rejection','role-boundary','device-binding','session-expiry'] }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
