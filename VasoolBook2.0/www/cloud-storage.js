(function () {
  'use strict';

  var CONFIG_KEY = 'cm_cloud_storage_config_v1';
  var STATUS_KEY = 'cm_cloud_storage_status_v1';
  var EMERGENCY_KEY = 'cm_cloud_storage_emergency_v1';
  var TOKEN_PREFIX = 'cloud.token.';
  var FILE_NAME = 'vasoolbook_cloud_backup.json';
  var ACTION_TIMEOUT = 120000;
  var memorySecrets = Object.create(null);
  var oauthWaiter = null;
  var actionBusy = false;

  var PROVIDERS = {
    google: {
      label: 'Google Drive',
      folder: 'appDataFolder'
    },
    onedrive: {
      label: 'OneDrive',
      endpoint: 'https://graph.microsoft.com/v1.0',
      authEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'offline_access Files.ReadWrite.AppFolder',
      folder: 'VasoolBook'
    },
    dropbox: {
      label: 'Dropbox',
      endpoint: 'https://api.dropboxapi.com/2',
      authEndpoint: 'https://www.dropbox.com/oauth2/authorize',
      tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
      scope: 'files.content.read files.content.write account_info.read',
      folder: 'VasoolBook'
    },
    webdav: {
      label: 'WebDAV / S3',
      folder: 'VasoolBook'
    },
    custom: {
      label: 'Custom API',
      folder: 'VasoolBook'
    }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function toast(message, type, duration) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type, duration);
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    var text = JSON.stringify(value);
    if (typeof window._safeSetItem === 'function') {
      window._safeSetItem(key, text);
    } else {
      localStorage.setItem(key, text);
    }
  }

  function nativeSecureBridge() {
    try {
      return window.VBSecureStorage || null;
    } catch (error) {
      return null;
    }
  }

  function parseNative(raw, operation) {
    var result = raw ? JSON.parse(raw) : null;
    if (!result || result.status !== 'ok') {
      throw new Error((result && result.message) || operation + ' failed');
    }
    return result;
  }

  var secureStore = {
    set: function (key, value) {
      var bridge = nativeSecureBridge();
      if (bridge && typeof bridge.setItem === 'function') {
        parseNative(bridge.setItem(key, String(value || '')), 'Secure storage write');
      } else {
        // Browser OAuth tokens are intentionally session-only. They are never
        // written to localStorage, backup JSON, logs, or application settings.
        memorySecrets[key] = String(value || '');
      }
      return Promise.resolve(true);
    },
    get: function (key) {
      var bridge = nativeSecureBridge();
      if (bridge && typeof bridge.getItem === 'function') {
        return Promise.resolve(parseNative(bridge.getItem(key), 'Secure storage read').value || '');
      }
      return Promise.resolve(memorySecrets[key] || '');
    },
    remove: function (key) {
      var bridge = nativeSecureBridge();
      if (bridge && typeof bridge.removeItem === 'function') {
        parseNative(bridge.removeItem(key), 'Secure storage delete');
      } else {
        delete memorySecrets[key];
      }
      return Promise.resolve(true);
    }
  };

  function providerDefaults(provider) {
    var base = PROVIDERS[provider] || PROVIDERS.google;
    return {
      provider: provider,
      clientId: '',
      endpoint: base.endpoint || '',
      authEndpoint: base.authEndpoint || '',
      tokenEndpoint: base.tokenEndpoint || '',
      scope: base.scope || '',
      username: '',
      folder: base.folder || 'VasoolBook',
      redirectUri: isNativeAndroid()
        ? 'vasoolbook://oauth/callback'
        : location.origin + location.pathname,
      updatedAt: ''
    };
  }

  function getConfig() {
    var saved = readJson(CONFIG_KEY, {});
    var provider = PROVIDERS[saved.provider] ? saved.provider : 'google';
    return Object.assign(providerDefaults(provider), saved, { provider: provider });
  }

  function saveConfig(config) {
    var safe = clone(config);
    delete safe.accessToken;
    delete safe.refreshToken;
    delete safe.password;
    delete safe.clientSecret;
    safe.updatedAt = new Date().toISOString();
    writeJson(CONFIG_KEY, safe);
    refreshSettingsStatus();
    return safe;
  }

  function getStatus() {
    return readJson(STATUS_KEY, {
      state: 'not_configured',
      provider: '',
      message: 'Not configured',
      lastBackup: '',
      lastRestore: '',
      lastTest: '',
      checksum: ''
    });
  }

  function setStatus(patch) {
    var next = Object.assign({}, getStatus(), patch, { updatedAt: new Date().toISOString() });
    writeJson(STATUS_KEY, next);
    renderStatus(next);
    refreshSettingsStatus();
    return next;
  }

  function providerLabel(provider) {
    return (PROVIDERS[provider] && PROVIDERS[provider].label) || provider || 'Cloud';
  }

  function refreshSettingsStatus() {
    var target = el('sv-cloud-status');
    if (!target) return;
    var config = getConfig();
    var status = getStatus();
    if (!config.clientId && !config.endpoint && config.provider !== 'google') {
      target.textContent = 'Not configured';
      target.style.color = '#888';
      return;
    }
    target.textContent = providerLabel(config.provider) + (status.state === 'connected' ? ' - Connected' : '');
    target.style.color = status.state === 'connected' ? '#17823b' : '#1B3A6B';
  }

  function isNativeAndroid() {
    try {
      return typeof window._gdIsNativeAndroid === 'function' && window._gdIsNativeAndroid();
    } catch (error) {
      return false;
    }
  }

  function timeout(promise, ms, label) {
    if (typeof window._vbWithTimeout === 'function') {
      return window._vbWithTimeout(promise, ms, label);
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error((label || 'Cloud operation') + ' timed out'));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function isRetryable(error) {
    var message = String(error && error.message || error || '');
    return !navigator.onLine || /network|fetch|timeout|temporar|429|5\d\d/i.test(message);
  }

  async function retry(operation, label, attempts) {
    var count = attempts || 3;
    var last;
    for (var i = 0; i < count; i += 1) {
      try {
        return await timeout(Promise.resolve().then(operation), ACTION_TIMEOUT, label);
      } catch (error) {
        last = error;
        if (i >= count - 1 || !isRetryable(error)) break;
        await sleep(Math.min(8000, 750 * Math.pow(2, i)));
      }
    }
    throw last;
  }

  async function fetchChecked(url, options, label) {
    var response = await retry(function () {
      return fetch(url, options || {});
    }, label || 'Cloud request', 3);
    if (!response.ok) {
      var detail = '';
      try { detail = (await response.text()).slice(0, 500); } catch (error) {}
      var err = new Error((label || 'Cloud request') + ' failed: HTTP ' + response.status + (detail ? ' - ' + detail : ''));
      err.status = response.status;
      throw err;
    }
    return response;
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text || ''));
  }

  function base64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function randomUrlSafe(size) {
    var bytes = new Uint8Array(size || 32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function sha256Base64Url(value) {
    if (!crypto || !crypto.subtle) throw new Error('Secure PKCE is unavailable in this browser');
    var hash = await crypto.subtle.digest('SHA-256', utf8Bytes(value));
    return base64Url(new Uint8Array(hash));
  }

  async function tokenBundle(provider) {
    var raw = await secureStore.get(TOKEN_PREFIX + provider);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  }

  async function saveTokenBundle(provider, bundle) {
    var safe = {
      accessToken: bundle.access_token || bundle.accessToken || '',
      refreshToken: bundle.refresh_token || bundle.refreshToken || '',
      tokenType: bundle.token_type || bundle.tokenType || 'Bearer',
      expiresAt: bundle.expires_in ? Date.now() + Number(bundle.expires_in) * 1000 : (bundle.expiresAt || 0),
      scope: bundle.scope || ''
    };
    await secureStore.set(TOKEN_PREFIX + provider, JSON.stringify(safe));
    return safe;
  }

  async function refreshAccessToken(config, bundle) {
    if (!bundle || !bundle.refreshToken || !config.tokenEndpoint) return null;
    var body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: config.clientId
    });
    var response = await fetchChecked(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }, providerLabel(config.provider) + ' token refresh');
    var refreshed = await response.json();
    if (!refreshed.refresh_token) refreshed.refresh_token = bundle.refreshToken;
    return saveTokenBundle(config.provider, refreshed);
  }

  async function getAccessToken(config) {
    if (config.provider === 'google') {
      if (!window.authService) throw new Error('Google authentication is unavailable');
      return timeout(window.authService.getAccessToken(''), 30000, 'Google sign-in');
    }
    var bundle = await tokenBundle(config.provider);
    if (bundle && bundle.accessToken && (!bundle.expiresAt || bundle.expiresAt > Date.now() + 60000)) {
      return bundle.accessToken;
    }
    bundle = await refreshAccessToken(config, bundle);
    if (bundle && bundle.accessToken) return bundle.accessToken;
    throw new Error(providerLabel(config.provider) + ' is not connected');
  }

  function nativeOAuthBridge() {
    try { return window.VBCloudOAuth || null; } catch (error) { return null; }
  }

  function openAuthorization(url) {
    var bridge = nativeOAuthBridge();
    if (isNativeAndroid() && bridge && typeof bridge.open === 'function') {
      parseNative(bridge.open(url), 'Native OAuth');
      return;
    }
    var popup = window.open(url, 'vb_cloud_oauth', 'popup=yes,width=520,height=720');
    if (!popup) throw new Error('Authorization popup was blocked. Allow popups and try again.');
  }

  async function connectPkce(config) {
    if (!config.clientId) throw new Error('Client ID is required');
    if (!config.authEndpoint || !config.tokenEndpoint) throw new Error('Authorization and token endpoints are required');
    if (!/^https:\/\//i.test(config.authEndpoint) || !/^https:\/\//i.test(config.tokenEndpoint)) {
      throw new Error('OAuth endpoints must use HTTPS');
    }
    var verifier = randomUrlSafe(48);
    var state = randomUrlSafe(24);
    var challenge = await sha256Base64Url(verifier);
    await secureStore.set('cloud.oauth.pending', JSON.stringify({
      provider: config.provider,
      verifier: verifier,
      state: state,
      createdAt: Date.now()
    }));
    var params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope || '',
      state: state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    if (config.provider === 'dropbox') params.set('token_access_type', 'offline');
    var authorizationUrl = config.authEndpoint + (config.authEndpoint.indexOf('?') >= 0 ? '&' : '?') + params.toString();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (oauthWaiter && oauthWaiter.state === state) oauthWaiter = null;
        reject(new Error('Authorization timed out. No local data was changed.'));
      }, 180000);
      oauthWaiter = {
        state: state,
        resolve: function (value) { clearTimeout(timer); oauthWaiter = null; resolve(value); },
        reject: function (error) { clearTimeout(timer); oauthWaiter = null; reject(error); }
      };
      openAuthorization(authorizationUrl);
    });
  }

  async function handleOAuthCallback(url) {
    var parsed;
    try { parsed = new URL(url); } catch (error) { return false; }
    var code = parsed.searchParams.get('code');
    var state = parsed.searchParams.get('state');
    var oauthError = parsed.searchParams.get('error');
    if (!code && !oauthError) return false;
    var pendingRaw = await secureStore.get('cloud.oauth.pending');
    var pending = pendingRaw ? JSON.parse(pendingRaw) : null;
    if (!pending || !state || pending.state !== state || Date.now() - Number(pending.createdAt || 0) > 300000) {
      throw new Error('OAuth state validation failed');
    }
    if (oauthError) {
      throw new Error('Authorization failed: ' + oauthError);
    }
    var config = getConfig();
    if (config.provider !== pending.provider) throw new Error('OAuth provider changed during authorization');
    var body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: pending.verifier
    });
    var response = await fetchChecked(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }, providerLabel(config.provider) + ' token exchange');
    var bundle = await saveTokenBundle(config.provider, await response.json());
    await secureStore.remove('cloud.oauth.pending');
    setStatus({ state: 'connected', provider: config.provider, message: 'Connected securely' });
    if (oauthWaiter && oauthWaiter.state === state) oauthWaiter.resolve(bundle.accessToken);
    toast(providerLabel(config.provider) + ' connected');
    open();
    return true;
  }

  function normalizePathPart(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
  }

  function encodePath(value) {
    return normalizePathPart(value).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function directUrl(config) {
    var base = String(config.endpoint || '').replace(/\/+$/g, '');
    if (!/^https:\/\//i.test(base)) throw new Error('Cloud endpoint must use HTTPS');
    var folder = encodePath(config.folder);
    return base + '/' + (folder ? folder + '/' : '') + encodeURIComponent(FILE_NAME);
  }

  async function authorizationHeaders(config, extra, optional) {
    var headers = Object.assign({}, extra || {});
    var token = '';
    try { token = await getAccessToken(config); } catch (error) {
      token = await secureStore.get(TOKEN_PREFIX + config.provider + '.manual');
      if (!token && !optional) throw error;
    }
    if (token) {
      if (/^(Basic|Bearer)\s/i.test(token)) {
        headers.Authorization = token;
      } else if (config.provider === 'webdav' && config.username) {
        headers.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(config.username + ':' + token)));
      } else {
        headers.Authorization = 'Bearer ' + token;
      }
    }
    return headers;
  }

  function oneDriveContentUrl(config) {
    return String(config.endpoint || PROVIDERS.onedrive.endpoint).replace(/\/+$/g, '') +
      '/me/drive/special/approot:/' + encodePath(config.folder) + '/' + encodeURIComponent(FILE_NAME) + ':/content';
  }

  function dropboxPath(config) {
    var folder = normalizePathPart(config.folder);
    return '/' + (folder ? folder + '/' : '') + FILE_NAME;
  }

  async function ensureRemoteFolder(config) {
    var parts = normalizePathPart(config.folder).split('/').filter(Boolean);
    if (!parts.length) return;
    if (config.provider === 'onedrive') {
      var oneHeaders = await authorizationHeaders(config, { 'Content-Type': 'application/json' });
      var base = String(config.endpoint || PROVIDERS.onedrive.endpoint).replace(/\/+$/g, '');
      var built = [];
      for (var i = 0; i < parts.length; i += 1) {
        var parent = built.length
          ? base + '/me/drive/special/approot:/' + encodePath(built.join('/')) + ':/children'
          : base + '/me/drive/special/approot/children';
        try {
          await fetchChecked(parent, {
            method: 'POST',
            headers: oneHeaders,
            body: JSON.stringify({ name: parts[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
          }, 'OneDrive folder check');
        } catch (error) {
          if (!(error && error.status === 409)) throw error;
        }
        built.push(parts[i]);
      }
    } else if (config.provider === 'dropbox') {
      var dropHeaders = await authorizationHeaders(config, { 'Content-Type': 'application/json' });
      try {
        await fetchChecked('https://api.dropboxapi.com/2/files/create_folder_v2', {
          method: 'POST',
          headers: dropHeaders,
          body: JSON.stringify({ path: '/' + normalizePathPart(config.folder), autorename: false })
        }, 'Dropbox folder check');
      } catch (error) {
        if (!(error && error.status === 409)) throw error;
      }
    }
  }

  async function uploadRemote(config, text) {
    if (config.provider === 'onedrive') {
      await ensureRemoteFolder(config);
      var oneHeaders = await authorizationHeaders(config, { 'Content-Type': 'application/json' });
      await fetchChecked(oneDriveContentUrl(config), { method: 'PUT', headers: oneHeaders, body: text }, 'OneDrive upload');
      return;
    }
    if (config.provider === 'dropbox') {
      await ensureRemoteFolder(config);
      var dropHeaders = await authorizationHeaders(config, {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath(config), mode: 'overwrite', autorename: false, mute: true })
      });
      await fetchChecked('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST', headers: dropHeaders, body: text
      }, 'Dropbox upload');
      return;
    }
    var headers = await authorizationHeaders(config, { 'Content-Type': 'application/json' }, true);
    await fetchChecked(directUrl(config), { method: 'PUT', headers: headers, body: text }, providerLabel(config.provider) + ' upload');
  }

  async function downloadRemote(config) {
    if (config.provider === 'onedrive') {
      var oneHeaders = await authorizationHeaders(config);
      return (await fetchChecked(oneDriveContentUrl(config), { headers: oneHeaders }, 'OneDrive download')).text();
    }
    if (config.provider === 'dropbox') {
      var dropHeaders = await authorizationHeaders(config, {
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath(config) })
      });
      return (await fetchChecked('https://content.dropboxapi.com/2/files/download', {
        method: 'POST', headers: dropHeaders
      }, 'Dropbox download')).text();
    }
    var headers = await authorizationHeaders(config, null, true);
    return (await fetchChecked(directUrl(config), { headers: headers }, providerLabel(config.provider) + ' download')).text();
  }

  async function remoteExists(config) {
    try {
      await downloadRemote(config);
      return true;
    } catch (error) {
      if (error && error.status === 404) return false;
      throw error;
    }
  }

  async function prepareBackup() {
    if (typeof window._gdBuildReadOnlyFullPayload !== 'function' ||
        typeof window._gdPrepareEnterprisePayload !== 'function') {
      throw new Error('Validated backup builder is unavailable');
    }
    var payload = window._gdBuildReadOnlyFullPayload();
    if (typeof window._vbVerifyBackupPayload === 'function') {
      window._vbVerifyBackupPayload(clone(payload), 'Cloud storage backup');
    }
    return timeout(window._gdPrepareEnterprisePayload(payload), 180000, 'Cloud backup validation');
  }

  async function stageEmergency(prepared, reason) {
    var snapshot = JSON.stringify({
      reason: reason,
      createdAt: new Date().toISOString(),
      checksum: prepared.sha256,
      size: prepared.size,
      text: prepared.text
    });
    if (typeof window._vbIdbSet === 'function') {
      var ok = await timeout(window._vbIdbSet(EMERGENCY_KEY, snapshot), 30000, 'Local emergency backup');
      if (!ok) throw new Error('Could not create local emergency backup');
    } else {
      memorySecrets[EMERGENCY_KEY] = snapshot;
    }
    return true;
  }

  async function exportVisibleFallback(prepared) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
    var filename = 'vasoolbook_cloud_fallback_' + stamp + '.json';
    try {
      if (window.VBLocalBackup && typeof window.VBLocalBackup.saveJson === 'function') {
        var result = JSON.parse(window.VBLocalBackup.saveJson(filename, prepared.text) || '{}');
        if (result.status !== 'saved') throw new Error(result.message || 'Local cloud fallback failed');
        return result.path || result.filename || filename;
      }
      var blob = new Blob([prepared.text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return filename;
    } catch (error) {
      return 'IndexedDB emergency snapshot';
    }
  }

  async function clearEmergency() {
    if (typeof window._vbIdbDelete === 'function') {
      await window._vbIdbDelete(EMERGENCY_KEY);
    } else if (typeof window._vbIdbOpen === 'function') {
      var db = await window._vbIdbOpen();
      if (db) {
        await new Promise(function (resolve) {
          try {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').delete(EMERGENCY_KEY);
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = tx.onabort = function () { resolve(false); };
          } catch (error) { resolve(false); }
        });
      }
    } else {
      delete memorySecrets[EMERGENCY_KEY];
    }
  }

  async function parseAndValidate(text, label) {
    var raw;
    try { raw = JSON.parse(text); } catch (error) { throw new Error(label + ' is not valid JSON'); }
    var checksum = typeof window._gdVerifyEnterpriseChecksum === 'function'
      ? await window._gdVerifyEnterpriseChecksum(raw, text, false)
      : { ok: true, sha256: '' };
    var data = typeof window._vbNormalizeBackupPayload === 'function'
      ? window._vbNormalizeBackupPayload(raw)
      : raw;
    var validation = typeof window._vbVerifyBackupPayload === 'function'
      ? window._vbVerifyBackupPayload(data, label)
      : { warnings: [] };
    return { data: data, validation: validation, checksum: checksum };
  }

  function backupSummary(data, size, checksum) {
    var borrowers = data.loanProfiles || data.borrowers || [];
    var history = data.entryLog || data.historyTab || [];
    return {
      borrowers: borrowers.length,
      loans: borrowers.length,
      history: history.length,
      size: size,
      checksum: checksum || ''
    };
  }

  async function backupGeneric(config) {
    var prepared = await prepareBackup();
    await stageEmergency(prepared, 'before-cloud-upload');
    var oldText = null;
    try {
      try { oldText = await retry(function () { return downloadRemote(config); }, 'Existing cloud backup check', 2); }
      catch (error) { if (!(error && error.status === 404)) throw error; }
      if (oldText) {
        var existing = await parseAndValidate(oldText, 'Existing cloud backup');
        if (existing.checksum.sha256 && existing.checksum.sha256 === prepared.sha256) {
          setStatus({ state: 'connected', provider: config.provider, message: 'Already synchronized', checksum: prepared.sha256 });
          await clearEmergency();
          return { skipped: true, summary: prepared.summary };
        }
        var oldTime = Date.parse(existing.data.exportedAt || existing.data.backupMetadata && existing.data.backupMetadata.createdTime || 0);
        var newTime = Date.parse(prepared.data.exportedAt || 0);
        if (oldTime && newTime && oldTime > newTime) throw new Error('A newer cloud backup exists. Upload stopped.');
        if (typeof window._gdDriveIntegritySummary === 'function' &&
            typeof window._gdBackupSafetyRisk === 'function' &&
            typeof window._gdShowBackupSafetyWarning === 'function') {
          var oldSummary = window._gdDriveIntegritySummary(existing.data, oldText);
          var risks = window._gdBackupSafetyRisk(oldSummary, prepared.summary);
          if (risks.length) {
            var approved = await window._gdShowBackupSafetyWarning(oldSummary, prepared.summary, risks);
            if (!approved) throw new DOMException('Cloud upload cancelled by safety check', 'AbortError');
          }
        }
      }
      await retry(function () { return uploadRemote(config, prepared.text); }, providerLabel(config.provider) + ' backup', 3);
      var verifyText = await retry(function () { return downloadRemote(config); }, 'Cloud upload verification', 3);
      var verified = await parseAndValidate(verifyText, 'Uploaded cloud backup');
      if (verified.checksum.sha256 !== prepared.sha256) throw new Error('Uploaded backup checksum mismatch');
      await clearEmergency();
      setStatus({
        state: 'connected',
        provider: config.provider,
        message: 'Backup verified',
        lastBackup: new Date().toISOString(),
        checksum: prepared.sha256,
        size: prepared.size
      });
      return { skipped: false, summary: prepared.summary };
    } catch (error) {
      var fallbackPath = await exportVisibleFallback(prepared);
      setStatus({
        state: 'error',
        provider: config.provider,
        message: 'Backup failed; local fallback retained at ' + fallbackPath
      });
      throw error;
    }
  }

  async function restoreGeneric(config) {
    var text = await retry(function () { return downloadRemote(config); }, providerLabel(config.provider) + ' restore download', 3);
    var incoming = await parseAndValidate(text, 'Cloud restore');
    var summary = backupSummary(incoming.data, utf8Bytes(text).length, incoming.checksum.sha256);
    var message = 'Restore preview\n\n' +
      'Provider: ' + providerLabel(config.provider) + '\n' +
      'Borrowers/Loans: ' + summary.borrowers + '\n' +
      'History: ' + summary.history + '\n' +
      'Size: ' + summary.size + ' bytes\n' +
      'Checksum: ' + (summary.checksum || 'Calculated for legacy backup') + '\n\n' +
      'Merge this verified backup into local data? Newer local records are preserved.';
    if (!confirm(message)) return { cancelled: true };
    var current = await prepareBackup();
    await stageEmergency(current, 'before-cloud-restore');
    try {
      if (typeof window._vbSaveMigratedBackupBeforeImport === 'function') {
        await window._vbSaveMigratedBackupBeforeImport(incoming.data, 'cloud:' + config.provider);
      }
      if (typeof window._vbApplyBackupDataSafely !== 'function') throw new Error('Atomic restore service is unavailable');
      var result = await timeout(
        window._vbApplyBackupDataSafely(incoming.data, 'cloud:' + config.provider),
        300000,
        'Atomic cloud restore'
      );
      setStatus({
        state: 'connected',
        provider: config.provider,
        message: 'Restore completed',
        lastRestore: new Date().toISOString(),
        checksum: incoming.checksum.sha256
      });
      return result;
    } catch (error) {
      setStatus({ state: 'error', provider: config.provider, message: 'Restore rolled back; local fallback retained' });
      throw error;
    }
  }

  function googleAdapter(config) {
    return {
      connect: async function () {
        if (!window.authService) throw new Error('Google authentication is unavailable');
        await timeout(window.authService.getAccessToken('consent'), 30000, 'Google Drive connect');
        setStatus({ state: 'connected', provider: 'google', message: 'Connected through existing Google Drive authentication' });
      },
      test: async function () {
        var token = await getAccessToken(config);
        var response = await fetchChecked('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
          headers: { Authorization: 'Bearer ' + token }
        }, 'Google Drive test');
        return response.json();
      },
      backup: function () {
        if (typeof window.backupToDrive !== 'function') throw new Error('Google Drive backup is unavailable');
        return window.backupToDrive();
      },
      restore: function () {
        if (typeof window.restoreFromDrive !== 'function') throw new Error('Google Drive restore is unavailable');
        return window.restoreFromDrive(false);
      },
      disconnect: async function () {
        if (window.authService && typeof window.authService.signOut === 'function') window.authService.signOut();
        setStatus({ state: 'disconnected', provider: 'google', message: 'Disconnected' });
      },
      status: getStatus
    };
  }

  function genericAdapter(config) {
    return {
      connect: async function () {
        var manual = String(el('cloud-secret-input') && el('cloud-secret-input').value || '').trim();
        if (manual) {
          await secureStore.set(TOKEN_PREFIX + config.provider + '.manual', manual);
          if (el('cloud-secret-input')) el('cloud-secret-input').value = '';
          setStatus({ state: 'connected', provider: config.provider, message: 'Credential stored securely' });
          return;
        }
        if (!config.authEndpoint || !config.tokenEndpoint) {
          var existing = await secureStore.get(TOKEN_PREFIX + config.provider + '.manual');
          setStatus({
            state: 'connected',
            provider: config.provider,
            message: existing ? 'Secure credential available' : 'Presigned/anonymous HTTPS endpoint configured'
          });
          return;
        }
        await connectPkce(config);
      },
      test: async function () {
        if (config.provider === 'onedrive') {
          var oneHeaders = await authorizationHeaders(config);
          return (await fetchChecked(String(config.endpoint).replace(/\/+$/g, '') + '/me/drive/special/approot', {
            headers: oneHeaders
          }, 'OneDrive test')).json();
        }
        if (config.provider === 'dropbox') {
          var dropHeaders = await authorizationHeaders(config, { 'Content-Type': 'application/json' });
          return (await fetchChecked('https://api.dropboxapi.com/2/users/get_current_account', {
            method: 'POST', headers: dropHeaders
          }, 'Dropbox test')).json();
        }
        return { exists: await remoteExists(config) };
      },
      backup: function () { return backupGeneric(config); },
      restore: function () { return restoreGeneric(config); },
      disconnect: async function () {
        await secureStore.remove(TOKEN_PREFIX + config.provider);
        await secureStore.remove(TOKEN_PREFIX + config.provider + '.manual');
        await secureStore.remove('cloud.oauth.pending');
        setStatus({ state: 'disconnected', provider: config.provider, message: 'Disconnected' });
      },
      status: getStatus
    };
  }

  function adapter(config) {
    return config.provider === 'google' ? googleAdapter(config) : genericAdapter(config);
  }

  function injectStyles() {
    if (el('vb-cloud-style')) return;
    var style = document.createElement('style');
    style.id = 'vb-cloud-style';
    style.textContent =
      '#vb-cloud-modal{display:none;position:fixed;inset:0;z-index:9900;background:rgba(0,0,0,.62);align-items:flex-end;justify-content:center;padding-top:env(safe-area-inset-top)}' +
      '#vb-cloud-modal.open{display:flex}' +
      '.vb-cloud-sheet{width:100%;max-width:520px;max-height:94dvh;overflow:auto;background:#f5f7fa;border-radius:18px 18px 0 0;padding-bottom:calc(14px + env(safe-area-inset-bottom));font-family:Poppins,sans-serif}' +
      '.vb-cloud-head{position:sticky;top:0;z-index:2;background:#1B3A6B;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
      '.vb-cloud-close{width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.18);color:#fff;font-size:19px}' +
      '.vb-cloud-body{padding:12px}' +
      '.vb-cloud-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.vb-cloud-field{margin-bottom:9px}' +
      '.vb-cloud-field label{display:block;font-size:9px;font-weight:800;color:#667085;text-transform:uppercase;margin:0 0 4px}' +
      '.vb-cloud-field input,.vb-cloud-field select{width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #dfe5ee;border-radius:8px;background:#fff;font:600 11px Poppins,sans-serif;color:#1a1a2e}' +
      '.vb-cloud-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}' +
      '.vb-cloud-actions button{min-height:42px;border:0;border-radius:8px;padding:8px 4px;font:800 11px Poppins,sans-serif;background:#e8eef8;color:#1B3A6B}' +
      '.vb-cloud-actions button.primary{background:#1B3A6B;color:#fff}' +
      '.vb-cloud-actions button.warn{background:#fff3df;color:#a55500}' +
      '.vb-cloud-actions button:disabled{opacity:.55}' +
      '#cloud-status-panel{background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:10px;margin-top:10px;font-size:10px;line-height:1.6;color:#475467;white-space:pre-wrap}' +
      '@media(max-width:390px){.vb-cloud-grid{grid-template-columns:1fr}.vb-cloud-actions{grid-template-columns:1fr 1fr}}';
    document.head.appendChild(style);
  }

  function ensureModal() {
    injectStyles();
    var modal = el('vb-cloud-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'vb-cloud-modal';
    modal.innerHTML =
      '<div class="vb-cloud-sheet" onclick="event.stopPropagation()">' +
        '<div class="vb-cloud-head"><div><div style="font-size:15px;font-weight:900">Cloud Storage</div><div style="font-size:9px;opacity:.78">One validated backup adapter</div></div><button class="vb-cloud-close" type="button" onclick="VBCloudStorage.close()" aria-label="Close">x</button></div>' +
        '<div class="vb-cloud-body">' +
          '<div class="vb-cloud-grid">' +
            '<div class="vb-cloud-field"><label>Provider</label><select id="cloud-provider" onchange="VBCloudStorage.providerChanged()"><option value="google">Google Drive</option><option value="onedrive">OneDrive</option><option value="dropbox">Dropbox</option><option value="webdav">WebDAV / S3</option><option value="custom">Custom API</option></select></div>' +
            '<div class="vb-cloud-field"><label>Folder</label><input id="cloud-folder" autocomplete="off"></div>' +
          '</div>' +
          '<div class="vb-cloud-field cloud-non-google"><label>Endpoint</label><input id="cloud-endpoint" inputmode="url" autocomplete="off" placeholder="HTTPS endpoint or presigned base URL"></div>' +
          '<div class="vb-cloud-field cloud-webdav-field"><label>WebDAV username</label><input id="cloud-username" autocomplete="username"></div>' +
          '<div class="vb-cloud-grid cloud-oauth-fields">' +
            '<div class="vb-cloud-field"><label>OAuth Client ID</label><input id="cloud-client-id" autocomplete="off"></div>' +
            '<div class="vb-cloud-field"><label>Redirect URI</label><input id="cloud-redirect-uri" autocomplete="off"></div>' +
          '</div>' +
          '<details class="cloud-oauth-fields" style="background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:9px;margin-bottom:9px"><summary style="font-size:10px;font-weight:800;color:#1B3A6B;cursor:pointer">OAuth PKCE settings</summary>' +
            '<div class="vb-cloud-field" style="margin-top:9px"><label>Authorization endpoint</label><input id="cloud-auth-endpoint" inputmode="url" autocomplete="off"></div>' +
            '<div class="vb-cloud-field"><label>Token endpoint</label><input id="cloud-token-endpoint" inputmode="url" autocomplete="off"></div>' +
            '<div class="vb-cloud-field"><label>Scopes</label><input id="cloud-scope" autocomplete="off"></div>' +
          '</details>' +
          '<div class="vb-cloud-field cloud-secret-field"><label>Access token / app password (never saved in app settings)</label><input id="cloud-secret-input" type="password" autocomplete="new-password" placeholder="Stored with Android Keystore"></div>' +
          '<button id="cloud-save-config" type="button" onclick="VBCloudStorage.saveFromForm()" style="width:100%;padding:11px;border:0;border-radius:8px;background:#e8eef8;color:#1B3A6B;font:800 11px Poppins,sans-serif">Save Configuration</button>' +
          '<div class="vb-cloud-actions">' +
            '<button class="primary" data-cloud-action="connect" onclick="VBCloudStorage.run(\'connect\',this)">Connect</button>' +
            '<button data-cloud-action="test" onclick="VBCloudStorage.run(\'test\',this)">Test</button>' +
            '<button class="primary" data-cloud-action="backup" onclick="VBCloudStorage.run(\'backup\',this)">Backup</button>' +
            '<button class="warn" data-cloud-action="restore" onclick="VBCloudStorage.run(\'restore\',this)">Restore</button>' +
            '<button data-cloud-action="status" onclick="VBCloudStorage.run(\'status\',this)">Sync Status</button>' +
            '<button data-cloud-action="disconnect" onclick="VBCloudStorage.run(\'disconnect\',this)">Disconnect</button>' +
          '</div>' +
          '<div id="cloud-status-panel"></div>' +
          '<div style="font-size:9px;color:#667085;line-height:1.5;margin-top:9px">OAuth uses PKCE and the system browser. No client-secret field exists. WebDAV/S3 must use a scoped token, app password, or presigned HTTPS endpoint.</div>' +
        '</div>' +
      '</div>';
    modal.onclick = close;
    document.body.appendChild(modal);
    return modal;
  }

  function fillForm(config) {
    el('cloud-provider').value = config.provider;
    el('cloud-folder').value = config.folder || '';
    el('cloud-endpoint').value = config.endpoint || '';
    el('cloud-client-id').value = config.clientId || '';
    el('cloud-username').value = config.username || '';
    el('cloud-redirect-uri').value = config.redirectUri || '';
    el('cloud-auth-endpoint').value = config.authEndpoint || '';
    el('cloud-token-endpoint').value = config.tokenEndpoint || '';
    el('cloud-scope').value = config.scope || '';
    el('cloud-secret-input').value = '';
    updateFieldVisibility(config.provider);
  }

  function formConfig() {
    return {
      provider: el('cloud-provider').value,
      folder: el('cloud-folder').value.trim(),
      endpoint: el('cloud-endpoint').value.trim(),
      clientId: el('cloud-client-id').value.trim(),
      username: el('cloud-username').value.trim(),
      redirectUri: el('cloud-redirect-uri').value.trim(),
      authEndpoint: el('cloud-auth-endpoint').value.trim(),
      tokenEndpoint: el('cloud-token-endpoint').value.trim(),
      scope: el('cloud-scope').value.trim()
    };
  }

  function updateFieldVisibility(provider) {
    document.querySelectorAll('.cloud-non-google').forEach(function (node) {
      node.style.display = provider === 'google' ? 'none' : '';
    });
    document.querySelectorAll('.cloud-oauth-fields').forEach(function (node) {
      node.style.display = provider === 'google' ? 'none' : '';
    });
    document.querySelectorAll('.cloud-secret-field').forEach(function (node) {
      node.style.display = provider === 'google' ? 'none' : '';
    });
    document.querySelectorAll('.cloud-webdav-field').forEach(function (node) {
      node.style.display = provider === 'webdav' ? '' : 'none';
    });
  }

  function renderStatus(status) {
    var panel = el('cloud-status-panel');
    if (!panel) return;
    status = status || getStatus();
    panel.textContent =
      'Provider: ' + providerLabel(status.provider || getConfig().provider) + '\n' +
      'State: ' + (status.state || 'not configured') + '\n' +
      'Message: ' + (status.message || '-') + '\n' +
      'Last test: ' + (status.lastTest ? new Date(status.lastTest).toLocaleString() : '-') + '\n' +
      'Last backup: ' + (status.lastBackup ? new Date(status.lastBackup).toLocaleString() : '-') + '\n' +
      'Last restore: ' + (status.lastRestore ? new Date(status.lastRestore).toLocaleString() : '-') + '\n' +
      'Checksum: ' + (status.checksum ? status.checksum.slice(0, 16) + '...' : '-');
  }

  function open() {
    var modal = ensureModal();
    fillForm(getConfig());
    renderStatus();
    modal.classList.add('open');
    consumeNativeCallback();
  }

  function close() {
    var modal = el('vb-cloud-modal');
    if (modal) modal.classList.remove('open');
  }

  function providerChanged() {
    var provider = el('cloud-provider').value;
    fillForm(providerDefaults(provider));
  }

  function saveFromForm(silent) {
    var config = formConfig();
    if (config.provider !== 'google') {
      if (!config.folder) config.folder = 'VasoolBook';
      if (config.endpoint && !/^https:\/\//i.test(config.endpoint)) {
        toast('Cloud endpoint must use HTTPS', 'err');
        return null;
      }
    }
    saveConfig(config);
    var currentStatus = getStatus();
    if (!silent || currentStatus.provider !== config.provider) {
      renderStatus(setStatus({
        provider: config.provider,
        state: 'configured',
        message: 'Configuration saved; secrets remain outside app settings'
      }));
    }
    if (!silent) toast('Cloud configuration saved');
    return config;
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll('[data-cloud-action]').forEach(function (button) {
      button.disabled = !!disabled;
    });
  }

  async function run(action, button) {
    if (actionBusy && action !== 'status') return;
    var permissionAction = action === 'status' ? 'cloud.status' : 'cloud.' + action;
    if (!window.VBPermissions || typeof window.VBPermissions.require !== 'function' || !window.VBPermissions.require(permissionAction)) return false;
    var config = saveFromForm(true);
    if (!config) return;
    var cloud = adapter(config);
    if (action === 'status') {
      renderStatus(cloud.status());
      return;
    }
    actionBusy = true;
    setButtonsDisabled(true);
    var original = button && button.textContent;
    if (button) button.textContent = action.charAt(0).toUpperCase() + action.slice(1) + '...';
    try {
      var result = await timeout(Promise.resolve(cloud[action]()), action === 'restore' ? 360000 : 180000, providerLabel(config.provider) + ' ' + action);
      if (action === 'test') setStatus({ state: 'connected', provider: config.provider, message: 'Connection test passed', lastTest: new Date().toISOString() });
      if (action === 'backup') setStatus({ state: 'connected', provider: config.provider, message: 'Backup completed and verified', lastBackup: new Date().toISOString() });
      if (action === 'restore') setStatus({ state: 'connected', provider: config.provider, message: 'Restore completed', lastRestore: new Date().toISOString() });
      toast(providerLabel(config.provider) + ' ' + action + ' completed');
      renderStatus();
      return result;
    } catch (error) {
      setStatus({ state: 'error', provider: config.provider, message: action + ' failed: ' + (error && error.message || error) });
      toast(providerLabel(config.provider) + ' ' + action + ' failed: ' + (error && error.message || error), 'err', 6000);
      return false;
    } finally {
      actionBusy = false;
      setButtonsDisabled(false);
      if (button) button.textContent = original;
    }
  }

  async function consumeNativeCallback() {
    var bridge = nativeOAuthBridge();
    if (!bridge || typeof bridge.consumeCallback !== 'function') return false;
    try {
      var result = parseNative(bridge.consumeCallback(), 'OAuth callback read');
      if (result.url) return handleOAuthCallback(result.url);
    } catch (error) {
      toast(error.message, 'err');
    }
    return false;
  }

  function handleLocationCallback() {
    if (!/[?&](code|error)=/.test(location.search)) return;
    if (window.opener && window.opener !== window && /^https?:$/i.test(location.protocol)) {
      try {
        window.opener.postMessage({ type: 'VB_CLOUD_OAUTH_CALLBACK', url: location.href }, location.origin);
        window.close();
        return;
      } catch (error) {}
    }
    handleOAuthCallback(location.href).then(function (handled) {
      if (handled && history.replaceState) history.replaceState({}, document.title, location.pathname + location.hash);
    }).catch(function (error) {
      if (oauthWaiter) oauthWaiter.reject(error);
      toast(error.message, 'err', 6000);
    });
  }

  window.vbHandleCloudOAuthCallback = function (url) {
    handleOAuthCallback(url).catch(function (error) {
      if (oauthWaiter) oauthWaiter.reject(error);
      toast(error.message, 'err', 6000);
    });
  };

  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || !event.data || event.data.type !== 'VB_CLOUD_OAUTH_CALLBACK') return;
    handleOAuthCallback(event.data.url).catch(function (error) {
      if (oauthWaiter) oauthWaiter.reject(error);
      toast(error.message, 'err', 6000);
    });
  });

  window.VBCloudStorage = {
    open: open,
    close: close,
    providerChanged: providerChanged,
    saveFromForm: saveFromForm,
    run: run,
    adapter: adapter,
    getConfig: getConfig,
    getStatus: getStatus,
    handleOAuthCallback: handleOAuthCallback,
    secureStore: secureStore,
    _prepareBackup: prepareBackup,
    _parseAndValidate: parseAndValidate
  };

  document.addEventListener('DOMContentLoaded', function () {
    refreshSettingsStatus();
    handleLocationCallback();
    consumeNativeCallback();
  });
})();
