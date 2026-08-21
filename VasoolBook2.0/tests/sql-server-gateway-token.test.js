'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/sql-server.js', 'utf8');
const storage = new Map();
const secure = new Map();
const fields = {
  'sql-provider': { value: 'turso' },
  'sql-api-url': { value: 'https://gateway.example.test/' },
  'sql-database': { value: 'vasoolbook' },
  'sql-username': { value: '' },
  'sql-token': { value: '  scoped-gateway-token  ' },
  'sql-status-panel': { textContent: '', style: {} },
  'sv-sql-status': { textContent: '', style: {} }
};
const requests = [];
const context = {
  console,
  URL,
  JSON,
  Promise,
  Map,
  Set,
  Math,
  Date,
  AbortController,
  navigator: { onLine: true },
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  document: {
    getElementById: id => fields[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} }
  },
  setTimeout,
  clearTimeout,
  fetch: async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ ok: true, message: 'Gateway OK', serverRevision: 'r1' })
    };
  }
};
context.window = context;
context.window.addEventListener = () => {};
context.window.showToast = () => {};
context.window.VBPermissions = { require: () => true };
context.window.isCloudDatabaseConnectionEnabled = () => true;
context.window._vbIdbGet = async () => [];
context.window._vbIdbSet = async () => true;
context.window.VBSecureStorage = {
  setItem: (key, value) => { secure.set(key, value); return JSON.stringify({ status: 'ok', value: '' }); },
  getItem: key => JSON.stringify({ status: 'ok', value: secure.get(key) || '' }),
  removeItem: key => { secure.delete(key); return JSON.stringify({ status: 'ok', value: '' }); }
};

vm.createContext(context);
vm.runInContext(source, context);

(async () => {
  const api = context.window.VBSQLServer;
  const saved = await api.saveFromForm();
  assert.equal(saved.apiUrl, 'https://gateway.example.test');
  assert.equal(fields['sql-token'].value, '', 'token input clears after secure save');
  assert.equal(Array.from(secure.values())[0], 'scoped-gateway-token', 'trimmed token persisted in Android secure storage');
  assert.equal(storage.get('cm_sql_server_config_v1').includes('scoped-gateway-token'), false, 'token never enters localStorage config');

  await api.run('test', { textContent: 'Test' });
  await api.run('connect', { textContent: 'Connect' });
  await api.run('diagnostics', { textContent: 'Diagnostics' });
  assert.ok(requests.length >= 3, 'test, connect, and diagnostics request the gateway');
  assert.ok(requests.every(request => request.options.headers.Authorization === 'Bearer scoped-gateway-token'), 'all gateway requests use the secure bearer token');
  assert.equal(fields['sql-status-panel'].textContent.includes('scoped-gateway-token'), false, 'diagnostics masks the token');
  assert.match(fields['sql-status-panel'].textContent, /Gateway token: Present \(scop\.\.\.oken\)/);
  assert.equal(await api.loadQueue().then(queue => queue.length), 0, 'test/connect/diagnostics do not alter the local queue');
  console.log(JSON.stringify({
    status: 'PASS',
    checks: ['save-trims-and-securely-persists-token', 'reopen-safe-token-reload', 'test-bearer-auth', 'connect-bearer-auth', 'masked-diagnostics', 'queue-preserved']
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
