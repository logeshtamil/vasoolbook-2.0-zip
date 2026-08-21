(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.VBLifetimeLicense = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var SECURE_RECORD_KEY = 'vb_lifetime_license_v1';
  var API_BASE_KEY = 'vb_license_api_base';
  var API_BASE_SECURE_KEY = 'vb_license_api_base_v1';
  var AUDIENCE = 'in.vasoolbook.app';
  var ISSUER = 'vasoolbook-licensing-api';
  var REQUEST_TIMEOUT_MS = 12000;
  var MAX_CLOCK_SKEW_SECONDS = 300;
  var state = { valid: false, status: 'none', licenseType: '', reason: '' };
  var initPromise = null;
  var apiBaseCache = '';
  var apiBaseLoaded = false;

  function storage() { return root.localStorage; }
  function nativeSecure() {
    return root.VBSecureStorage && typeof root.VBSecureStorage.getItem === 'function'
      ? root.VBSecureStorage : null;
  }
  function nativeResult(raw, action) {
    var parsed;
    try { parsed = JSON.parse(String(raw || '{}')); }
    catch (_) { throw new Error(action + ' returned malformed data.'); }
    if (parsed.status !== 'ok') throw new Error(parsed.message || (action + ' failed.'));
    return String(parsed.value || '');
  }
  async function secureReadKey(key) {
    var bridge = nativeSecure();
    if (bridge) {
      var raw = bridge.getItem(key);
      if (raw && typeof raw.then === 'function') raw = await raw;
      return nativeResult(raw, 'Secure storage read');
    }
    try { return storage().getItem(key) || ''; } catch (_) { return ''; }
  }
  async function secureWriteKey(key, value) {
    var bridge = nativeSecure();
    if (bridge) {
      var raw = bridge.setItem(key, String(value || ''));
      if (raw && typeof raw.then === 'function') raw = await raw;
      nativeResult(raw, 'Secure storage write');
      return true;
    }
    storage().setItem(key, String(value || ''));
    return true;
  }
  async function secureRemoveKey(key) {
    var bridge = nativeSecure();
    if (bridge) {
      var raw = bridge.removeItem(key);
      if (raw && typeof raw.then === 'function') raw = await raw;
      nativeResult(raw, 'Secure storage delete');
      return;
    }
    try { storage().removeItem(key); } catch (_) {}
  }
  function secureRead() { return secureReadKey(SECURE_RECORD_KEY); }
  function secureWrite(value) { return secureWriteKey(SECURE_RECORD_KEY, value); }
  function secureRemove() { return secureRemoveKey(SECURE_RECORD_KEY); }
  function secureStorageStatus() { return nativeSecure() ? 'android-keystore' : 'signed-web-storage'; }

  function normalizeApiBase(value) {
    var raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    var parsed;
    try { parsed = new URL(raw); } catch (_) { throw new Error('Enter a valid Licensing API URL.'); }
    var local = /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      throw new Error('Licensing API must use HTTPS.');
    }
    if (parsed.username || parsed.password) throw new Error('Licensing API URL must not contain credentials.');
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }
  function getApiBase() {
    var configured = apiBaseCache;
    if (!configured) { try { configured = storage().getItem(API_BASE_KEY) || ''; } catch (_) {} }
    try { return normalizeApiBase(configured); } catch (_) { return ''; }
  }
  function setApiBase(value) {
    var normalized = normalizeApiBase(value);
    apiBaseCache = normalized;
    apiBaseLoaded = true;
    var bridge = nativeSecure();
    if (bridge) {
      nativeResult(bridge.setItem(API_BASE_SECURE_KEY, normalized), 'Secure licensing URL write');
      try { storage().removeItem(API_BASE_KEY); } catch (_) {}
    } else {
      storage().setItem(API_BASE_KEY, normalized);
    }
    return normalized;
  }
  async function loadApiBase() {
    if (apiBaseLoaded) return getApiBase();
    var configured = '';
    try { configured = await secureReadKey(API_BASE_SECURE_KEY); } catch (_) {}
    if (!configured) { try { configured = storage().getItem(API_BASE_KEY) || ''; } catch (_) {} }
    try { apiBaseCache = normalizeApiBase(configured); } catch (_) { apiBaseCache = ''; }
    apiBaseLoaded = true;
    if (apiBaseCache && nativeSecure()) {
      await secureWriteKey(API_BASE_SECURE_KEY, apiBaseCache);
      try { storage().removeItem(API_BASE_KEY); } catch (_) {}
    }
    return apiBaseCache;
  }
  async function saveApiBase(value) {
    var normalized = normalizeApiBase(value);
    apiBaseCache = normalized;
    apiBaseLoaded = true;
    await secureWriteKey(nativeSecure() ? API_BASE_SECURE_KEY : API_BASE_KEY, normalized);
    if (nativeSecure()) { try { storage().removeItem(API_BASE_KEY); } catch (_) {} }
    return normalized;
  }

  function b64urlBytes(value) {
    var input = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    var binary = root.atob ? root.atob(input) : Buffer.from(input, 'base64').toString('binary');
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  function decodePart(value) {
    var bytes = b64urlBytes(value);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function textBytes(value) { return new TextEncoder().encode(String(value || '')); }
  function bytesHex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  function canonicalPublicKey(jwk) {
    return JSON.stringify({ kty: jwk && jwk.kty || '', crv: jwk && jwk.crv || '', x: jwk && jwk.x || '' });
  }
  async function publicKeyFingerprint(jwk) {
    if (!root.crypto || !root.crypto.subtle) throw new Error('Secure license verification is unavailable on this device.');
    return bytesHex(await root.crypto.subtle.digest('SHA-256', textBytes(canonicalPublicKey(jwk))));
  }
  function parseToken(token) {
    var parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('License token is malformed.');
    return { parts: parts, header: decodePart(parts[0]), claims: decodePart(parts[1]) };
  }
  async function verifySignature(token, jwk) {
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) throw new Error('License signing key is invalid.');
    var parsed = parseToken(token);
    if (parsed.header.alg !== 'EdDSA' || parsed.header.typ !== 'JWT') throw new Error('License token algorithm is invalid.');
    var key = await root.crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    var valid = await root.crypto.subtle.verify({ name: 'Ed25519' }, key, b64urlBytes(parsed.parts[2]), textBytes(parsed.parts[0] + '.' + parsed.parts[1]));
    if (!valid) throw new Error('License token signature is invalid.');
    return parsed;
  }
  function validateClaims(claims, deviceId, nowSeconds) {
    nowSeconds = Number(nowSeconds || Math.floor(Date.now() / 1000));
    if (!claims || claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw new Error('License token issuer is invalid.');
    if (claims.licenseType !== 'lifetime' || claims.expiry !== null) throw new Error('This is not a Developer Lifetime License.');
    if (!claims.sub || !claims.jti || !claims.deviceId) throw new Error('License token is incomplete.');
    if (String(claims.deviceId) !== String(deviceId || '')) throw new Error('License belongs to another device.');
    if (!Number.isFinite(Number(claims.iat)) || Number(claims.iat) > nowSeconds + MAX_CLOCK_SKEW_SECONDS) throw new Error('License token time is invalid.');
    if (!Number.isFinite(Number(claims.offlineValidUntil)) || Number(claims.offlineValidUntil) < nowSeconds) throw new Error('Online license revalidation is required.');
    return true;
  }
  async function verifyEnvelope(body, deviceId, existingRecord) {
    body = body || {};
    if (!body.valid || !body.signedToken || !body.signingPublicKey) throw new Error(body.message || body.reason || 'License verification failed.');
    var fingerprint = await publicKeyFingerprint(body.signingPublicKey);
    if (existingRecord && existingRecord.keyFingerprint && existingRecord.keyFingerprint !== fingerprint) {
      throw new Error('Licensing server signing key changed. Admin reset is required.');
    }
    var parsed = await verifySignature(body.signedToken, body.signingPublicKey);
    validateClaims(parsed.claims, deviceId);
    if (body.signingKeyId && parsed.header.kid !== body.signingKeyId) throw new Error('License signing key ID mismatch.');
    return {
      schemaVersion: 1,
      token: body.signedToken,
      publicKey: body.signingPublicKey,
      keyFingerprint: fingerprint,
      claims: parsed.claims,
      verifiedAt: new Date().toISOString(),
      lastOnlineValidationAt: new Date().toISOString(),
      apiBase: getApiBase()
    };
  }
  async function verifyStoredRecord(record, deviceId) {
    if (!record || !record.token || !record.publicKey || !record.claims) throw new Error('No verified lifetime license is stored.');
    var fingerprint = await publicKeyFingerprint(record.publicKey);
    if (fingerprint !== record.keyFingerprint) throw new Error('Stored license signing key was modified.');
    var parsed = await verifySignature(record.token, record.publicKey);
    validateClaims(parsed.claims, deviceId);
    if (JSON.stringify(parsed.claims) !== JSON.stringify(record.claims)) throw new Error('Stored license claims were modified.');
    return record;
  }

  function setupRequiredError() {
    var error = new Error('Licensing API Base URL is not configured. Open Settings > License and save the server URL first.');
    error.code = 'LICENSE_API_NOT_CONFIGURED';
    return error;
  }
  async function requestJson(path, options) {
    options = options || {};
    var apiBase = options.apiBase ? normalizeApiBase(options.apiBase) : getApiBase();
    if (!apiBase) throw setupRequiredError();
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      var response = await root.fetch(apiBase + path, {
        method: options.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: (options.method || 'POST') === 'GET' ? undefined : JSON.stringify(options.payload || {}),
        signal: controller ? controller.signal : undefined,
        cache: 'no-store'
      });
      var text = await response.text(), body = {};
      try { body = text ? JSON.parse(text) : {}; } catch (_) { throw new Error('Licensing API returned invalid JSON (HTTP ' + response.status + ').'); }
      if (!response.ok || (options.requireValid && !body.valid)) {
        var error = new Error(body.message || body.reason || ('Licensing API error HTTP ' + response.status));
        error.httpStatus = response.status; error.reason = body.reason || '';
        throw error;
      }
      return { body: body, status: response.status, path: path };
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Licensing API request timed out.');
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  async function request(path, payload) {
    return (await requestJson(path, { method: 'POST', payload: payload, requireValid: true })).body;
  }
  async function testConnection(value) {
    var apiBase = normalizeApiBase(value != null ? value : getApiBase());
    if (!apiBase) throw setupRequiredError();
    var paths = ['/health', '/api/license/health'], lastError = null;
    for (var i = 0; i < paths.length; i++) {
      try {
        var result = await requestJson(paths[i], { method: 'GET', apiBase: apiBase });
        return { ok: true, apiBase: apiBase, endpoint: paths[i], httpStatus: result.status, response: result.body };
      } catch (error) {
        lastError = error;
        if (!(error && (error.httpStatus === 404 || error.httpStatus === 405))) break;
      }
    }
    throw lastError || new Error('Licensing API health check failed.');
  }
  async function licenseStatus(deviceId) {
    deviceId = currentDeviceId(deviceId);
    return (await requestJson('/api/license/status', { method: 'POST', payload: { deviceId: deviceId, appVersion: appVersion() } })).body;
  }
  async function revokeRemote(deviceId) {
    deviceId = currentDeviceId(deviceId);
    var record = await readRecord();
    var result = await requestJson('/api/license/revoke', { method: 'POST', payload: { deviceId: deviceId, token: record && record.token || '' } });
    await secureRemove();
    setInvalid(result.body.message || 'License was revoked.');
    return result.body;
  }
  async function adminCall(action, payload) {
    action = String(action || '').trim().toLowerCase();
    if (['status', 'list', 'issue', 'revoke', 'reset'].indexOf(action) < 0) throw new Error('Unsupported licensing admin action.');
    return (await requestJson('/api/license/admin/' + action, { method: 'POST', payload: payload || {} })).body;
  }
  function deviceModel() { try { return String(root.navigator && root.navigator.userAgent || '').slice(0, 180); } catch (_) { return ''; } }
  function appVersion() { return String(root.VB_APP_VERSION || root.APP_VERSION_NAME || 'unknown'); }
  function currentDeviceId(explicit) {
    if (explicit) return String(explicit);
    if (typeof root._getDeviceId === 'function') return String(root._getDeviceId());
    return '';
  }
  function setValid(record, offline) {
    state = {
      valid: true,
      status: 'lifetime',
      licenseType: 'lifetime',
      expiry: null,
      daysRemaining: null,
      remainingDays: 'Unlimited',
      offline: !!offline,
      clientId: record.claims.sub,
      revalidateAfter: record.claims.revalidateAfter,
      offlineValidUntil: record.claims.offlineValidUntil,
      storage: secureStorageStatus(),
      reason: ''
    };
    return state;
  }
  function setInvalid(reason) {
    state = { valid: false, status: 'invalid', licenseType: '', reason: String(reason || 'License is invalid.') };
    return state;
  }
  async function readRecord() {
    var raw = await secureRead();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { throw new Error('Stored license data is malformed.'); }
  }
  async function saveRecord(record) {
    await secureWrite(JSON.stringify(record));
    var reread = await readRecord();
    if (!reread || reread.token !== record.token || reread.keyFingerprint !== record.keyFingerprint) throw new Error('Secure license storage verification failed.');
  }
  async function revokeLocal(reason) {
    await secureRemove();
    return setInvalid(reason || 'License was reset.');
  }
  async function activate(licenseKey, deviceId) {
    var key = String(licenseKey || '').trim();
    if (!key || key.length > 128) throw new Error('Enter a valid server-issued license key.');
    deviceId = currentDeviceId(deviceId);
    if (!deviceId) throw new Error('Device ID is unavailable.');
    var existing = null;
    try { existing = await readRecord(); } catch (_) {}
    var body = await request('/api/license/validate', { licenseKey: key, deviceId: deviceId, appVersion: appVersion(), deviceModel: deviceModel() });
    if (String(body.licenseType || body.plan || '').toLowerCase() !== 'lifetime') throw new Error('This key is not a Developer Lifetime License.');
    var record = await verifyEnvelope(body, deviceId, existing);
    await saveRecord(record);
    return setValid(record, false);
  }
  async function revalidate(record, deviceId) {
    try {
      var body = await request('/api/license/verify', { token: record.token, deviceId: deviceId, appVersion: appVersion(), deviceModel: deviceModel() });
      var updated = await verifyEnvelope(body, deviceId, record);
      await saveRecord(updated);
      return setValid(updated, false);
    } catch (error) {
      if (error && error.httpStatus) { await revokeLocal(error.reason || error.message); throw error; }
      validateClaims(record.claims, deviceId);
      return setValid(record, true);
    }
  }
  async function initialize(options) {
    options = options || {};
    if (initPromise && !options.force) return initPromise;
    initPromise = (async function () {
      var deviceId = currentDeviceId(options.deviceId), record;
      try {
        await loadApiBase();
        record = await readRecord();
        if (!record) return setInvalid('No lifetime license is stored.');
        await verifyStoredRecord(record, deviceId);
        var online = options.online !== undefined ? !!options.online : !(root.navigator && root.navigator.onLine === false);
        if (online && !getApiBase()) {
          var offlineState = setValid(record, true);
          offlineState.reason = setupRequiredError().message;
          return offlineState;
        }
        if (online) return await revalidate(record, deviceId);
        return setValid(record, true);
      } catch (error) {
        if (record && /modified|malformed|signature|another device|incomplete|issuer|algorithm/i.test(String(error.message || error))) await secureRemove();
        return setInvalid(error && error.message || error);
      } finally { initPromise = null; }
    })();
    return initPromise;
  }

  return {
    activate: activate,
    initialize: initialize,
    revalidate: function () { return initialize({ force: true, online: true }); },
    getState: function () { return Object.assign({}, state); },
    getApiBase: getApiBase,
    setApiBase: setApiBase,
    loadApiBase: loadApiBase,
    saveApiBase: saveApiBase,
    testConnection: testConnection,
    getLicenseStatus: licenseStatus,
    revoke: revokeRemote,
    adminCall: adminCall,
    resetLocal: revokeLocal,
    secureStorageStatus: secureStorageStatus,
    _test: {
      parseToken: parseToken,
      verifySignature: verifySignature,
      validateClaims: validateClaims,
      verifyEnvelope: verifyEnvelope,
      verifyStoredRecord: verifyStoredRecord,
      publicKeyFingerprint: publicKeyFingerprint,
      secureRead: secureRead,
      requestJson: requestJson,
      normalizeApiBase: normalizeApiBase,
      setupRequiredError: setupRequiredError
    }
  };
});
