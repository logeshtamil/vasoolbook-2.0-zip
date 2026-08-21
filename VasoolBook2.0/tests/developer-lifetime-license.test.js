'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const factory = require('../www/license-security.js');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; },
    map
  };
}
function secureBridge(backing) {
  return {
    getItem: (k) => JSON.stringify({ status: 'ok', value: backing.get(k) || '' }),
    setItem: (k, v) => { backing.set(k, String(v)); return JSON.stringify({ status: 'ok', value: '' }); },
    removeItem: (k) => { backing.delete(k); return JSON.stringify({ status: 'ok', value: '' }); }
  };
}
function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

const pair = crypto.generateKeyPairSync('ed25519');
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const kid = crypto.createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
function token(deviceId, overrides) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid };
  const claims = Object.assign({ iss: 'vasoolbook-licensing-api', aud: 'in.vasoolbook.app', sub: 'OWNER-1', jti: crypto.randomUUID(), deviceId, licenseType: 'lifetime', expiry: null, iat: now, revalidateAfter: now + 3600, offlineValidUntil: now + 259200, keyHash: 'server-key-hash' }, overrides || {});
  const input = b64(header) + '.' + b64(claims);
  return input + '.' + crypto.sign(null, Buffer.from(input), pair.privateKey).toString('base64url');
}
function response(body, status) {
  return { ok: (status || 200) < 400, status: status || 200, text: async () => JSON.stringify(body) };
}
function makeRoot(deviceId, secure, local, handler, online) {
  return {
    crypto: crypto.webcrypto,
    localStorage: local,
    VBSecureStorage: secureBridge(secure),
    navigator: { onLine: online !== false, userAgent: 'VasoolBook-Test' },
    _getDeviceId: () => deviceId,
    fetch: handler,
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    VB_APP_VERSION: '2.4.45'
  };
}

(async function () {
  const secure = new Map(), local = memoryStorage();
  let validateCalls = 0, verifyCalls = 0;
  const root = makeRoot('VB-DEVICE-A', secure, local, async (url) => {
    if (url.endsWith('/api/license/validate')) { validateCalls++; return response({ valid: true, plan: 'Lifetime', licenseType: 'lifetime', signedToken: token('VB-DEVICE-A'), signingPublicKey: publicJwk, signingKeyId: kid }); }
    verifyCalls++; return response({ valid: true, plan: 'Lifetime', licenseType: 'lifetime', signedToken: token('VB-DEVICE-A'), signingPublicKey: publicJwk, signingKeyId: kid });
  });
  const api = factory(root);
  api.setApiBase('https://licenses.vasoolbook.test/');
  const activated = await api.activate('VB-RANDOM-SERVER-KEY', 'VB-DEVICE-A');
  assert.equal(activated.valid, true);
  assert.equal(activated.status, 'lifetime');
  assert.equal(activated.remainingDays, 'Unlimited');
  assert.equal(validateCalls, 1);
  assert.equal(local.map.has('vb_lifetime_license_v1'), false, 'Android record must use native secure storage');
  assert.ok(secure.has('vb_lifetime_license_v1'));
  assert.doesNotMatch(secure.get('vb_lifetime_license_v1'), /VB-RANDOM-SERVER-KEY/, 'activation key must never be persisted');
  const online = await api.initialize({ deviceId: 'VB-DEVICE-A', online: true, force: true });
  assert.equal(online.valid, true);
  assert.equal(online.offline, false);
  assert.equal(verifyCalls, 1);

  const noUrlSecure = new Map(secure);
  noUrlSecure.delete('vb_license_api_base_v1');
  let noUrlFetches = 0;
  const noUrlApi = factory(makeRoot('VB-DEVICE-A', noUrlSecure, memoryStorage(), async () => { noUrlFetches++; throw new Error('must not be called'); }, true));
  const noUrlState = await noUrlApi.initialize({ deviceId: 'VB-DEVICE-A', online: true });
  assert.equal(noUrlState.valid, true, 'verified offline license remains valid when server URL is not configured');
  assert.equal(noUrlState.offline, true);
  assert.match(noUrlState.reason, /Base URL is not configured.*Settings/i);
  assert.equal(noUrlFetches, 0, 'startup must not attempt remote verification without a configured URL');

  const freshApi = factory(makeRoot('VB-FRESH', new Map(), memoryStorage(), async () => { throw new Error('not called'); }, false));
  assert.equal((await freshApi.initialize({ deviceId: 'VB-FRESH', online: false })).valid, false);

  const offlineApi = factory(makeRoot('VB-DEVICE-A', new Map(secure), memoryStorage({ vb_license_api_base: 'https://licenses.vasoolbook.test' }), async () => { throw new Error('offline'); }, false));
  const offline = await offlineApi.initialize({ deviceId: 'VB-DEVICE-A', online: false });
  assert.equal(offline.valid, true);
  assert.equal(offline.offline, true);

  const mismatchSecure = new Map(secure);
  const mismatchApi = factory(makeRoot('VB-DEVICE-B', mismatchSecure, memoryStorage({ vb_license_api_base: 'https://licenses.vasoolbook.test' }), async () => { throw new Error('offline'); }, false));
  assert.equal((await mismatchApi.initialize({ deviceId: 'VB-DEVICE-B', online: false })).valid, false);
  assert.equal(mismatchSecure.has('vb_lifetime_license_v1'), false);

  const tamperedSecure = new Map(secure), record = JSON.parse(tamperedSecure.get('vb_lifetime_license_v1'));
  const storedParts = record.token.split('.');
  storedParts[2] = (storedParts[2][0] === 'A' ? 'B' : 'A') + storedParts[2].slice(1);
  record.token = storedParts.join('.');
  tamperedSecure.set('vb_lifetime_license_v1', JSON.stringify(record));
  const tamperedApi = factory(makeRoot('VB-DEVICE-A', tamperedSecure, memoryStorage({ vb_license_api_base: 'https://licenses.vasoolbook.test' }), async () => { throw new Error('offline'); }, false));
  assert.equal((await tamperedApi.initialize({ deviceId: 'VB-DEVICE-A', online: false })).valid, false);
  assert.equal(tamperedSecure.has('vb_lifetime_license_v1'), false);

  const revokeSecure = new Map(secure);
  const revokeApi = factory(makeRoot('VB-DEVICE-A', revokeSecure, memoryStorage({ vb_license_api_base: 'https://licenses.vasoolbook.test' }), async () => response({ valid: false, reason: 'blocked' }, 403), true));
  assert.equal((await revokeApi.initialize({ deviceId: 'VB-DEVICE-A', online: true })).valid, false);
  assert.equal(revokeSecure.has('vb_lifetime_license_v1'), false);

  const index = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8');
  const sqlite = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'sqliteDataIntegrity.js'), 'utf8');
  assert.match(index, /badge\.textContent='LIFETIME'/);
  assert.match(index, /expEl\.textContent='Lifetime'/);
  assert.match(index, /remEl\.textContent='Unlimited'/);
  assert.match(index, /function _validateCode\(/, 'legacy dated paid workflow remains present');
  assert.match(index, /status==='licensed'/, 'legacy paid display remains present');
  assert.match(sqlite, /k\.indexOf\('vb_lifetime_license'\)!==0/);
  assert.match(sqlite, /k!=='vb_license_api_base'/);
  assert.doesNotMatch(index + fs.readFileSync(path.join(__dirname, '..', 'www', 'license-security.js'), 'utf8'), /LIFETIME_MASTER|UNIVERSAL_LIFETIME|lifetimeActivationCode/i);

  console.log(JSON.stringify({ status: 'PASS', checks: ['fresh-install-trial-fallback','fresh-lifetime-activation','android-secure-storage','activation-key-not-persisted','online-revalidation','empty-url-zero-fetch-offline-preserved','offline-restart','device-mismatch','tampered-token','online-revocation','restore-exclusion','lifetime-ui','trial-paid-preserved','no-universal-code'], calls: { validate: validateCalls, verify: verifyCalls } }, null, 2));
})().catch((error) => { console.error(error); process.exit(1); });
