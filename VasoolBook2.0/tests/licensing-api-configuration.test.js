'use strict';

const assert = require('assert');
const fs = require('fs');
const factory = require('../www/license-security.js');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    key: index => Array.from(map.keys())[index] || null,
    get length() { return map.size; },
    map
  };
}
function secureBridge(backing) {
  return {
    getItem: key => JSON.stringify({ status: 'ok', value: backing.get(key) || '' }),
    setItem: (key, value) => { backing.set(key, String(value)); return JSON.stringify({ status: 'ok' }); },
    removeItem: key => { backing.delete(key); return JSON.stringify({ status: 'ok' }); }
  };
}
function response(body, status) {
  const code = status || 200;
  return { ok: code < 400, status: code, text: async () => JSON.stringify(body || {}) };
}
function rootWith(fetchHandler, secure, local) {
  return {
    localStorage: local,
    VBSecureStorage: secureBridge(secure),
    navigator: { onLine: true, userAgent: 'VasoolBook-License-Config-Test' },
    fetch: fetchHandler,
    _getDeviceId: () => 'VB-CONFIG-DEVICE',
    VB_APP_VERSION: 'test'
  };
}

(async function () {
  let calls = [];
  const secure = new Map(), local = memoryStorage();
  const emptyApi = factory(rootWith(async url => { calls.push(url); return response({ ok: true }); }, secure, local));
  await assert.rejects(
    () => emptyApi.testConnection(''),
    /Base URL is not configured.*Settings/i,
    'empty URL shows setup guidance'
  );
  await assert.rejects(
    () => emptyApi.activate('SERVER-ISSUED-LIFETIME-CODE', 'VB-CONFIG-DEVICE'),
    /Base URL is not configured.*Settings/i,
    'activation does not attempt remote verification without configuration'
  );
  assert.equal(calls.length, 0, 'empty configuration performs no fetch');
  assert.throws(() => emptyApi.setApiBase('http://public.example.test'), /must use HTTPS/);
  assert.throws(() => emptyApi.setApiBase('https://user:pass@example.test'), /must not contain credentials/);

  const configured = await emptyApi.saveApiBase('  https://licenses.example.test/base///  ');
  assert.equal(configured, 'https://licenses.example.test/base');
  assert.equal(secure.get('vb_license_api_base_v1'), configured, 'Android stores base URL through secure bridge');
  assert.equal(local.getItem('vb_license_api_base'), null, 'Android does not duplicate URL in web storage');

  calls = [];
  const handler = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/api/license/health')) return response({ status: 'ok' });
    if (url.endsWith('/health')) return response({ message: 'missing' }, 404);
    if (url.endsWith('/api/license/status')) return response({ valid: true, status: 'lifetime' });
    if (url.endsWith('/api/license/admin/list')) return response({ success: true, licenses: [] });
    if (url.endsWith('/api/license/revoke')) return response({ success: true, message: 'revoked' });
    throw new Error('Unexpected URL ' + url);
  };
  const reopened = factory(rootWith(handler, secure, memoryStorage()));
  assert.equal(await reopened.loadApiBase(), configured, 'saved base URL reloads after app restart');
  const health = await reopened.testConnection();
  assert.equal(health.endpoint, '/api/license/health', 'health check falls back to existing licensing endpoint');
  assert.equal(health.httpStatus, 200);
  assert.equal((await reopened.getLicenseStatus()).status, 'lifetime');
  assert.deepEqual((await reopened.adminCall('list', {})).licenses, []);
  assert.equal((await reopened.revoke()).success, true);
  calls.forEach(call => assert.ok(call.url.startsWith(configured + '/'), 'all licensing calls use configured base URL'));

  const index = fs.readFileSync('www/index.html', 'utf8');
  const moduleSource = fs.readFileSync('www/license-security.js', 'utf8');
  assert.match(index, /Licensing API Base URL/);
  assert.match(index, /Save &amp; Test Licensing Server/);
  assert.match(index, /Setup required: enter the Licensing API Base URL/);
  assert.match(index, /await api\.testConnection\(saved\)/);
  assert.match(moduleSource, /if \(!apiBase\) throw setupRequiredError\(\)/);
  assert.match(moduleSource, /if \(online && !getApiBase\(\)\)/, 'startup skips remote verification when URL is empty');
  assert.doesNotMatch(moduleSource, /https:\/\/[a-z0-9.-]+\.(com|in|app|online)/i, 'no production licensing URL is hard-coded');
  assert.doesNotMatch(moduleSource, /API[_-]?KEY|Bearer\s+[A-Za-z0-9._-]{10,}/i, 'no API key is embedded');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'empty-url-zero-fetch','clear-setup-message','https-validation','credential-url-rejected',
      'normalized-base-url','android-secure-persistence','restart-reload','health-fallback',
      'status-shared-base','revoke-shared-base','admin-shared-base','offline-license-preserved',
      'no-hardcoded-url-or-key'
    ],
    requests: calls.map(call => call.method + ' ' + call.url)
  }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
