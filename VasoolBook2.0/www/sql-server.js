(function () {
  'use strict';

  var CONFIG_KEY = 'cm_sql_server_config_v1';
  var STATUS_KEY = 'cm_sql_server_status_v1';
  var QUEUE_KEY = 'cm_sql_sync_queue_v1';
  var MANIFEST_KEY = 'cm_sql_sync_manifest_v1';
  var EMERGENCY_KEY = 'cm_sql_sync_emergency_v1';
  var BACKUP_FALLBACK_KEY = 'cm_sql_backup_fallback_v1';
  var TOKEN_KEY = 'sql.server.access-token';
  var PROTOCOL_VERSION = 1;
  var REQUEST_TIMEOUT_MS = 30000;
  var SYNC_TIMEOUT_MS = 180000;
  var MAX_RETRIES = 3;
  var actionBusy = false;
  var memorySecrets = Object.create(null);
  var autoFlushBusy = false;
  var activeRequestControllers = [];

  var PROVIDERS = {
    vasoolbook: 'VasoolBook Backend',
    turso: 'Turso / libSQL Gateway',
    firebase: 'Firebase Gateway',
    postgres: 'PostgreSQL Gateway',
    mysql: 'MySQL Gateway',
    mssql: 'Microsoft SQL Gateway',
    custom: 'Custom REST API'
  };

  var SYNC_ARRAYS = [
    'customers',
    'loanProfiles',
    'entryLog',
    'areas',
    'nonAccTxns',
    'upiIds',
    'expenses',
    'reminders',
    'collReports'
  ];

  var FINANCIAL_ARRAYS = {
    loanProfiles: true,
    entryLog: true,
    nonAccTxns: true,
    expenses: true,
    collReports: true
  };

  function el(id) {
    return document.getElementById(id);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
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
    try {
      var text = JSON.stringify(value);
      if (typeof window._safeSetItem === 'function') window._safeSetItem(key, text);
      else localStorage.setItem(key, text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function cloudDatabaseEnabled() {
    if (typeof window.isCloudDatabaseConnectionEnabled === 'function') {
      return window.isCloudDatabaseConnectionEnabled();
    }
    try {
      var settings = JSON.parse(localStorage.getItem('cm_cfg') || '{}');
      return settings.cloud_database_connection !== '0';
    } catch (error) {
      return true;
    }
  }

  function cloudDatabaseOffError() {
    var error = new Error('Cloud Database Connection is OFF. Local data and pending sync are safe.');
    error.code = 'cloud_database_off';
    return error;
  }

  function abortRemoteRequests() {
    activeRequestControllers.slice().forEach(function (controller) {
      try { controller.abort(); } catch (error) {}
    });
    activeRequestControllers.length = 0;
  }

  function redact(value) {
    return String(value == null ? '' : value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
      .replace(/([?&](?:token|key|secret|password|credential)=)[^&\s]+/gi, '$1[redacted]')
      .slice(0, 600);
  }

  function toast(message, type, duration) {
    if (typeof window.showToast === 'function') {
      window.showToast(String(message || ''), type || 'ok', duration || 2800);
    }
  }

  function parseNative(raw, label) {
    var result = raw;
    if (typeof raw === 'string') {
      try {
        result = JSON.parse(raw);
      } catch (error) {
        throw new Error((label || 'Native operation') + ' returned invalid data');
      }
    }
    if (!result || result.status === 'error' || result.ok === false) {
      throw new Error(result && result.message || (label || 'Native operation') + ' failed');
    }
    return result;
  }

  var secureStore = {
    set: function (key, value) {
      if (window.VBCloudStorage && window.VBCloudStorage.secureStore) {
        return window.VBCloudStorage.secureStore.set(key, value);
      }
      try {
        if (window.VBSecureStorage && typeof window.VBSecureStorage.setItem === 'function') {
          parseNative(window.VBSecureStorage.setItem(key, String(value || '')), 'Secure storage write');
          return Promise.resolve(true);
        }
      } catch (error) {
        return Promise.reject(error);
      }
      memorySecrets[key] = String(value || '');
      return Promise.resolve(true);
    },
    get: function (key) {
      if (window.VBCloudStorage && window.VBCloudStorage.secureStore) {
        return window.VBCloudStorage.secureStore.get(key);
      }
      try {
        if (window.VBSecureStorage && typeof window.VBSecureStorage.getItem === 'function') {
          return Promise.resolve(parseNative(
            window.VBSecureStorage.getItem(key),
            'Secure storage read'
          ).value || '');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(memorySecrets[key] || '');
    },
    remove: function (key) {
      if (window.VBCloudStorage && window.VBCloudStorage.secureStore) {
        return window.VBCloudStorage.secureStore.remove(key);
      }
      try {
        if (window.VBSecureStorage && typeof window.VBSecureStorage.removeItem === 'function') {
          parseNative(window.VBSecureStorage.removeItem(key), 'Secure storage delete');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      delete memorySecrets[key];
      return Promise.resolve(true);
    }
  };

  function providerLabel(provider) {
    return PROVIDERS[provider] || PROVIDERS.custom;
  }

  function identityHash(value) {
    var hash = 2166136261;
    String(value || '').split('').forEach(function (character) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function connectionId(config) {
    config = sanitizeConfig(config);
    return config.provider + '-' + identityHash([
      config.apiUrl.toLowerCase(), config.database, config.username
    ].join('|'));
  }

  function providerTokenKey(config) {
    return TOKEN_KEY + '.' + connectionId(config);
  }

  function normalizeAccessToken(value, required) {
    var token = String(value == null ? '' : value).trim();
    if (/^\$?\{?[A-Z][A-Z0-9_]{4,}\}?$/.test(token)) {
      throw new Error('Use a scoped Gateway Access Token, not a database environment variable.');
    }
    if (required && !token) {
      throw new Error('Gateway Access Token is required. Save a non-empty token first.');
    }
    return token;
  }

  function secureStorageStatus() {
    try {
      if (window.VBSecureStorage && typeof window.VBSecureStorage.getItem === 'function') {
        return 'Android Keystore';
      }
    } catch (error) {}
    return 'Browser session memory';
  }

  async function readAccessToken(config) {
    var scopedKey = providerTokenKey(config);
    var scoped = normalizeAccessToken(await secureStore.get(scopedKey), false);
    if (scoped) return scoped;
    var status = getStatus();
    if (status.provider === config.provider) {
      var legacy = normalizeAccessToken(await secureStore.get(TOKEN_KEY), false);
      if (legacy) {
        await secureStore.set(scopedKey, legacy);
        await secureStore.remove(TOKEN_KEY);
        return legacy;
      }
    }
    return '';
  }

  async function saveAccessToken(config, token) {
    token = normalizeAccessToken(token, true);
    await secureStore.set(providerTokenKey(config), token);
    await secureStore.remove(TOKEN_KEY);
    return true;
  }

  async function removeAccessToken(config) {
    await secureStore.remove(providerTokenKey(config));
    if (getStatus().provider === config.provider) await secureStore.remove(TOKEN_KEY);
    return true;
  }

  function defaultConfig() {
    return {
      provider: 'vasoolbook',
      apiUrl: '',
      database: '',
      username: ''
    };
  }

  function sanitizeConfig(input) {
    input = input && typeof input === 'object' ? input : {};
    var config = {
      provider: Object.prototype.hasOwnProperty.call(PROVIDERS, input.provider)
        ? input.provider : 'vasoolbook',
      apiUrl: String(input.apiUrl || '').trim().replace(/\/+$/g, ''),
      database: String(input.database || '').trim(),
      username: String(input.username || '').trim()
    };
    return config;
  }

  function getConfig() {
    return Object.assign(defaultConfig(), sanitizeConfig(readJson(CONFIG_KEY, {})));
  }

  function saveConfig(input) {
    var config = sanitizeConfig(input);
    var safe = {
      provider: config.provider,
      apiUrl: config.apiUrl,
      database: config.database,
      username: config.username
    };
    if (!writeJson(CONFIG_KEY, safe)) throw new Error('Database connection settings could not be saved');
    return safe;
  }

  function getStatus() {
    return Object.assign({
      state: 'not configured',
      provider: getConfig().provider,
      message: '',
      pending: 0,
      serverRevision: '',
      lastTest: '',
      lastSync: '',
      dataChecksum: '',
      conflicts: 0
    }, readJson(STATUS_KEY, {}));
  }

  function setStatus(patch) {
    patch = Object.assign({}, patch || {});
    ['token', 'accessToken', 'refreshToken', 'password', 'clientSecret', 'serviceAccount'].forEach(function (key) {
      delete patch[key];
    });
    if (patch.message !== undefined) patch.message = redact(patch.message);
    var status = Object.assign(getStatus(), patch);
    writeJson(STATUS_KEY, status);
    refreshSettingsStatus(status);
    return status;
  }

  async function disabledResult(action, config) {
    var queue = await loadQueue();
    config = config || getConfig();
    var destination = connectionId(config);
    var pending = queue.filter(function (item) {
      return item && item.connectionId === destination;
    }).length;
    var status = setStatus({
      state: 'disabled',
      provider: config.provider,
      connectionId: destination,
      message: 'Cloud Database Connection is OFF. Local saves and backups continue normally.',
      pending: pending
    });
    return Object.assign({}, status, {
      skipped: true,
      cloudDatabase: 'off',
      action: action || 'none',
      pending: pending
    });
  }

  function refreshSettingsStatus(status) {
    var target = el('sv-sql-status');
    if (!target) return;
    if (!cloudDatabaseEnabled()) {
      target.textContent = 'Cloud: OFF';
      target.style.color = '#888';
      return;
    }
    status = status || getStatus();
    if (status.state === 'connected' || status.state === 'synchronized') {
      target.textContent = status.pending ? 'Cloud: ON - '+status.pending+' pending' : 'Cloud: ON - Connected';
      target.style.color = '#168f53';
    } else if (status.state === 'queued') {
      target.textContent = 'Cloud: ON - '+(status.pending || 1)+' queued';
      target.style.color = '#a15c00';
    } else if (status.state === 'conflict' || status.state === 'error') {
      target.textContent = 'Cloud: ON - '+(status.state === 'conflict' ? 'Conflict' : 'Error');
      target.style.color = '#c0392b';
    } else if (getConfig().apiUrl) {
      target.textContent = 'Cloud: ON - Configured';
      target.style.color = '#1B3A6B';
    } else {
      target.textContent = 'Cloud: ON - Not configured';
      target.style.color = '#888';
    }
  }

  function validateConfig(config) {
    config = sanitizeConfig(config);
    if (!config.apiUrl) throw new Error('Backend API URL is required');
    var parsed;
    try {
      parsed = new URL(config.apiUrl);
    } catch (error) {
      throw new Error('Backend API URL is invalid');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Backend API must use HTTPS');
    }
    if (parsed.username || parsed.password) {
      throw new Error('Do not include credentials in the API URL');
    }
    var sensitiveQuery = false;
    parsed.searchParams.forEach(function (value, key) {
      if (/token|key|secret|password|credential|auth/i.test(key)) sensitiveQuery = true;
    });
    if (sensitiveQuery) throw new Error('Do not include tokens or secrets in the API URL');
    if (/^(jdbc|mysql|postgres|postgresql|mssql|sqlserver|libsql):/i.test(config.apiUrl)) {
      throw new Error('Direct database connections are not allowed');
    }
    if (!config.database || config.database.length > 240) {
      throw new Error('Database name is required');
    }
    if (/[\r\n]/.test(config.database)) throw new Error('Database identifier is invalid');
    if (config.provider === 'turso') {
      if (!/^[A-Za-z0-9_. -]+$/.test(config.database)
          && !/^libsql:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/i.test(config.database)) {
        throw new Error('Enter a Turso database name or libsql:// database URL without a token');
      }
    } else if (config.provider === 'firebase') {
      if (!/^[A-Za-z0-9_.-]+$/.test(config.database)) throw new Error('Firebase Project ID is invalid');
    } else if (!/^[A-Za-z0-9_. -]+$/.test(config.database)) {
      throw new Error('Database name contains unsupported characters');
    }
    if (config.username.length > 160) {
      throw new Error('Username is too long');
    }
    return config;
  }

  function endpoint(config, path) {
    return validateConfig(config).apiUrl + path;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function withTimeout(promise, ms, label) {
    if (typeof window._vbWithTimeout === 'function') {
      return window._vbWithTimeout(promise, ms, label);
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error((label || 'Database operation') + ' timed out'));
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

  function shouldRetry(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function requestErrorDetail(error) {
    var status = Number(error && error.status || 0);
    var prefix = status ? 'HTTP ' + status : (error && error.name === 'AbortError' ? 'Timeout' : 'Gateway error');
    var message = redact(error && error.message || 'Gateway request failed');
    return prefix + ': ' + message;
  }

  async function requestJson(config, path, options, tokenOverride) {
    if (!cloudDatabaseEnabled()) throw cloudDatabaseOffError();
    config = validateConfig(config);
    options = options || {};
    var savedStatus = getStatus();
    if (tokenOverride === undefined && savedStatus.connectionId === connectionId(config)
        && savedStatus.credentialExpiresAt) {
      var expiresAt = Date.parse(savedStatus.credentialExpiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30000) {
        throw new Error('Secure session expired. Connect again with a fresh token.');
      }
    }
    var token = normalizeAccessToken(tokenOverride !== undefined ? tokenOverride : await readAccessToken(config), true);
    var body = options.body === undefined ? undefined : JSON.stringify(options.body);
    var timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    var lastError = null;

    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      var controller = new AbortController();
      activeRequestControllers.push(controller);
      var timer = setTimeout(function () {
        controller.abort();
      }, timeoutMs);
      try {
        var headers = Object.assign({
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token,
          'X-VasoolBook-Protocol': String(PROTOCOL_VERSION),
          'X-VasoolBook-Provider': config.provider,
          'X-VasoolBook-Database': config.database,
          'X-VasoolBook-Connection': connectionId(config),
          'X-VasoolBook-Auth-Mode': config.provider === 'firebase' && tokenOverride !== undefined
            ? 'firebase-id-token'
            : (savedStatus.connectionId === connectionId(config) && savedStatus.credentialType
              ? savedStatus.credentialType : 'scoped-gateway-token')
        }, options.headers || {});
        if (config.username) headers['X-VasoolBook-Username'] = config.username;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        var response = await fetch(endpoint(config, path), {
          method: options.method || 'GET',
          headers: headers,
          body: body,
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit'
        });
        var text = await response.text();
        var parsed = {};
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            var invalidJson = new Error('HTTP ' + response.status + ': Gateway returned invalid JSON');
            invalidJson.status = response.status;
            throw invalidJson;
          }
        }
        if (!response.ok) {
          var httpError = new Error('HTTP ' + response.status + ': ' + redact(parsed.message || response.statusText || 'Gateway request failed'));
          httpError.status = response.status;
          if (shouldRetry(response.status) && attempt + 1 < MAX_RETRIES) {
            lastError = httpError;
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw httpError;
        }
        if (parsed && parsed.ok === false) {
          var backendError = new Error(parsed.message || 'Backend rejected the request');
          backendError.code = parsed.code || 'backend_rejected';
          backendError.conflicts = parsed.conflicts || [];
          throw backendError;
        }
        return parsed;
      } catch (error) {
        lastError = error;
        if (!cloudDatabaseEnabled()) throw cloudDatabaseOffError();
        var retryable = error && (error.name === 'AbortError' || !error.status || shouldRetry(error.status));
        if (retryable && attempt + 1 < MAX_RETRIES) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        if (error && error.name === 'AbortError') {
          throw new Error('Backend request timed out');
        }
        throw error;
      } finally {
        clearTimeout(timer);
        activeRequestControllers = activeRequestControllers.filter(function (active) { return active !== controller; });
      }
    }
    throw lastError || new Error('Backend request failed');
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  async function sha256(text) {
    if (typeof window._gdSha256 === 'function') return window._gdSha256(String(text || ''));
    if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') {
      throw new Error('SHA-256 is unavailable in this WebView');
    }
    var bytes = new TextEncoder().encode(String(text || ''));
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function businessDataCopy(data) {
    var copy = clone(data || {});
    delete copy.exportedAt;
    delete copy.backupMetadata;
    if (copy.integrity && typeof copy.integrity === 'object') delete copy.integrity.sha256;
    if (copy.migration && typeof copy.migration === 'object') {
      delete copy.migration.migratedAt;
    }
    return copy;
  }

  async function dataChecksum(data) {
    return sha256(stableStringify(businessDataCopy(data)));
  }

  function recordKey(kind, item, index) {
    item = item || {};
    var value = '';
    if (kind === 'customers') value = item.id || item.customerId;
    else if (kind === 'loanProfiles') value = item.id || item.loanId || item.loanno;
    else if (kind === 'entryLog') value = item.id;
    else if (kind === 'areas') value = item.id || item.areaId || item.name;
    else value = item.id || item.transactionId || item.reportId || item.name;
    if (value !== undefined && value !== null && String(value) !== '') {
      return String(value);
    }
    return 'legacy-' + identityHash(kind + '|' + stableStringify(item));
  }

  function recordVersion(item) {
    item = item || {};
    var values = [item.recordVersion, item.rowVersion, item.version, item.revision];
    for (var i = 0; i < values.length; i++) {
      var value = Number(values[i]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  }

  function recordTime(item) {
    item = item || {};
    var values = [
      item.updated_at, item.updatedAt, item.modifiedAt, item.modifiedTime,
      item.created_at, item.createdAt, item.ts, item.timestamp, item.date
    ];
    for (var i = 0; i < values.length; i++) {
      if (!values[i]) continue;
      var time = Date.parse(values[i]);
      if (Number.isFinite(time)) return time;
    }
    return 0;
  }

  function occurrenceMap(list, kind, conflicts, source) {
    var map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (item, index) {
      var base = recordKey(kind, item, index);
      var existing = map[base];
      if (existing === undefined) {
        map[base] = item;
        return;
      }
      var existingText = stableStringify(existing);
      var itemText = stableStringify(item);
      if (existingText === itemText) return;
      var existingVersion = recordVersion(existing), itemVersion = recordVersion(item);
      var existingTime = recordTime(existing), itemTime = recordTime(item);
      if (itemVersion > existingVersion || (itemVersion === existingVersion && itemTime > existingTime)) {
        map[base] = item;
        return;
      }
      if (existingVersion > itemVersion || (itemVersion === existingVersion && existingTime > itemTime)) return;
      if (FINANCIAL_ARRAYS[kind]) {
        conflicts.push({
          entity: kind,
          recordKey: base,
          source: source || 'snapshot',
          reason: 'Duplicate financial ID has equal version/time but different data'
        });
      }
      // Equal ambiguous non-financial rows keep the first stable value.
    });
    return map;
  }

  function mergeArray(kind, localList, remoteList, conflicts) {
    var localMap = occurrenceMap(localList, kind, conflicts, 'local');
    var remoteMap = occurrenceMap(remoteList, kind, conflicts, 'remote');
    var keys = Object.keys(Object.assign({}, localMap, remoteMap)).sort();
    return keys.map(function (key) {
      var local = localMap[key];
      var remote = remoteMap[key];
      if (local === undefined) return clone(remote);
      if (remote === undefined) return clone(local);
      var localText = stableStringify(local);
      var remoteText = stableStringify(remote);
      if (localText === remoteText) return clone(local);
      var localVersion = recordVersion(local);
      var remoteVersion = recordVersion(remote);
      if (remoteVersion > localVersion) return clone(remote);
      if (localVersion > remoteVersion) return clone(local);
      var localTime = recordTime(local);
      var remoteTime = recordTime(remote);
      if (remoteTime > localTime) return clone(remote);
      if (localTime > remoteTime) return clone(local);
      if (FINANCIAL_ARRAYS[kind]) {
        conflicts.push({
          entity: kind,
          recordKey: key,
          reason: 'Same version/timestamp with different financial data'
        });
      }
      return clone(local);
    });
  }

  function paymentMap(logs) {
    var map = {};
    (logs || []).forEach(function (entry) {
      var id = String(entry && (
        entry.bid || entry.loanId || entry.loanProfileId || entry.borrowerId
      ) || '');
      if (!id) return;
      (map[id] || (map[id] = [])).push(clone(entry));
    });
    return map;
  }

  function mergePayloads(localData, remoteData) {
    var local = typeof window._vbNormalizeBackupPayload === 'function'
      ? window._vbNormalizeBackupPayload(clone(localData)) : clone(localData);
    var remote = typeof window._vbNormalizeBackupPayload === 'function'
      ? window._vbNormalizeBackupPayload(clone(remoteData)) : clone(remoteData);
    var merged = clone(local);
    var conflicts = [];

    SYNC_ARRAYS.forEach(function (kind) {
      merged[kind] = mergeArray(kind, local[kind], remote[kind], conflicts);
    });
    merged.borrowers = clone(merged.loanProfiles || []);
    merged.historyTab = clone(merged.entryLog || []);
    merged.paymentHistory = clone(merged.entryLog || []);
    merged.borrowerWisePaymentHistory = paymentMap(merged.entryLog || []);
    merged.paymentHistoryByBorrower = clone(merged.borrowerWisePaymentHistory);
    merged.openingPaidEntries = (merged.entryLog || []).filter(function (entry) {
      return typeof window._vbIsOpeningPaidEntry === 'function'
        ? window._vbIsOpeningPaidEntry(entry)
        : !!(entry && (entry.isOpeningPaid || entry.isOpeningBalance));
    }).map(clone);
    merged.cashbook = Object.assign({}, remote.cashbook || {}, local.cashbook || {});
    merged.settings = Object.assign({}, remote.settings || {}, local.settings || {});
    merged.legacyRecords = Object.assign({}, remote.legacyRecords || {}, local.legacyRecords || {});
    merged.retiredAreaIds = {
      main: Object.assign(
        {},
        remote.retiredAreaIds && remote.retiredAreaIds.main || {},
        local.retiredAreaIds && local.retiredAreaIds.main || {}
      ),
      sub: Object.assign(
        {},
        remote.retiredAreaIds && remote.retiredAreaIds.sub || {},
        local.retiredAreaIds && local.retiredAreaIds.sub || {}
      )
    };
    merged.exportedAt = new Date().toISOString();
    if (merged.backupMetadata) delete merged.backupMetadata.sha256;
    if (merged.integrity) delete merged.integrity.sha256;
    return { data: merged, conflicts: conflicts };
  }

  function countSummary(data) {
    data = data || {};
    return {
      customers: Array.isArray(data.customers) ? data.customers.length : 0,
      borrowers: Array.isArray(data.loanProfiles) ? data.loanProfiles.length : 0,
      loans: Array.isArray(data.loanProfiles) ? data.loanProfiles.length : 0,
      payments: Array.isArray(data.entryLog) ? data.entryLog.length : 0,
      history: Array.isArray(data.entryLog) ? data.entryLog.length : 0,
      areas: Array.isArray(data.areas) ? data.areas.length : 0,
      reports: Array.isArray(data.collReports) ? data.collReports.length : 0
    };
  }

  async function buildManifest(data) {
    var datasets = {};
    for (var i = 0; i < SYNC_ARRAYS.length; i++) {
      var kind = SYNC_ARRAYS[i];
      var list = Array.isArray(data[kind]) ? data[kind] : [];
      datasets[kind] = {
        count: list.length,
        checksum: await sha256(stableStringify(list))
      };
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: data.schemaVersion || 0,
      backupVersion: data.backupVersion || data.version || 0,
      datasets: datasets
    };
  }

  async function prepareSnapshot(source) {
    if (typeof window._gdBuildReadOnlyFullPayload !== 'function'
        || typeof window._gdPrepareEnterprisePayload !== 'function'
        || typeof window._vbVerifyBackupPayload !== 'function') {
      throw new Error('VasoolBook data integrity services are unavailable');
    }
    var raw = source || window._gdBuildReadOnlyFullPayload();
    window._vbVerifyBackupPayload(raw, 'SQL sync snapshot');
    var prepared = await window._gdPrepareEnterprisePayload(raw);
    window._vbVerifyBackupPayload(prepared.data, 'SQL sync prepared snapshot');
    return {
      data: prepared.data,
      checksum: prepared.sha256,
      dataChecksum: await dataChecksum(prepared.data),
      size: prepared.size,
      summary: countSummary(prepared.data),
      manifest: await buildManifest(prepared.data)
    };
  }

  async function verifyRemoteSnapshot(snapshot, expectedChecksum) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Backend snapshot is missing or invalid');
    }
    if (!expectedChecksum) throw new Error('Backend snapshot checksum is missing');
    if (typeof window._gdVerifyEnterpriseChecksum === 'function') {
      var checked = await window._gdVerifyEnterpriseChecksum(
        snapshot,
        JSON.stringify(snapshot),
        false
      );
      if (expectedChecksum && String(checked.sha256).toLowerCase() !== String(expectedChecksum).toLowerCase()) {
        throw new Error('Backend snapshot checksum mismatch');
      }
    } else {
      var directChecksum = await sha256(JSON.stringify(snapshot));
      if (String(directChecksum).toLowerCase() !== String(expectedChecksum).toLowerCase()) {
        throw new Error('Backend snapshot checksum mismatch');
      }
    }
    var normalized = typeof window._vbNormalizeBackupPayload === 'function'
      ? window._vbNormalizeBackupPayload(clone(snapshot)) : clone(snapshot);
    window._vbVerifyBackupPayload(normalized, 'SQL backend snapshot');
    return normalized;
  }

  async function stageEmergencySnapshot(localPrepared, reason) {
    if (typeof window._vbIdbSet !== 'function') {
      throw new Error('IndexedDB emergency storage is unavailable');
    }
    var snapshot = {
      reason: reason || 'sql-sync',
      createdAt: new Date().toISOString(),
      checksum: localPrepared.checksum,
      dataChecksum: localPrepared.dataChecksum,
      summary: localPrepared.summary,
      data: localPrepared.data
    };
    var saved = await window._vbIdbSet(EMERGENCY_KEY, snapshot);
    if (!saved) throw new Error('Could not create SQL sync emergency snapshot');
    try {
      var sqlite = window.VBSQLiteIntegrity;
      if (sqlite && typeof sqlite.isActive === 'function' && sqlite.isActive()
          && typeof sqlite.emergencySnapshot === 'function') {
        await sqlite.emergencySnapshot(reason || 'before-sql-sync-merge');
      }
    } catch (error) {
      throw new Error('SQLite emergency snapshot failed: ' + error.message);
    }
    return snapshot;
  }

  async function applyServerSnapshot(remoteSnapshot, remoteChecksum) {
    if (window._gdBackupReadOnlyPhase) {
      var deferredError = new Error('Remote database apply is deferred until the active Google Drive snapshot completes. Local data and sync queue are unchanged.');
      deferredError.code = 'drive_backup_snapshot_active';
      deferredError.retryable = true;
      throw deferredError;
    }
    var remote = await verifyRemoteSnapshot(remoteSnapshot, remoteChecksum);
    var localPrepared = await prepareSnapshot();
    var merged = mergePayloads(localPrepared.data, remote);
    if (merged.conflicts.length) {
      var conflictError = new Error(
        merged.conflicts.length + ' unresolved financial conflict(s); local data was not changed'
      );
      conflictError.code = 'financial_conflict';
      conflictError.conflicts = merged.conflicts;
      throw conflictError;
    }
    var preparedMerge = await prepareSnapshot(merged.data);
    var localCounts = localPrepared.summary;
    var remoteCounts = countSummary(remote);
    var mergedCounts = preparedMerge.summary;
    ['customers', 'borrowers', 'payments', 'areas', 'reports'].forEach(function (name) {
      if (mergedCounts[name] < Math.max(localCounts[name], remoteCounts[name])) {
        throw new Error('SQL merge integrity failed: ' + name + ' count decreased');
      }
    });
    await stageEmergencySnapshot(localPrepared, 'before-sql-server-merge');
    if (typeof window._vbApplyBackupDataSafely !== 'function') {
      throw new Error('Atomic restore service is unavailable');
    }
    var verifiedAfter = null;
    var result = await window._vbApplyBackupDataSafely(
      preparedMerge.data,
      'sql-server-sync',
      async function (incoming, previousState) {
        verifiedAfter = await prepareSnapshot();
        var after = verifiedAfter.summary;
        var baseline = countSummary(previousState);
        var source = countSummary(incoming);
        ['customers', 'borrowers', 'payments', 'areas', 'reports'].forEach(function (name) {
          if (after[name] < Math.max(baseline[name], source[name])) {
            throw new Error('SQL atomic merge validation failed: ' + name + ' count decreased');
          }
        });
      }
    );
    if (!verifiedAfter) throw new Error('SQL atomic merge validation did not run');
    return {
      applyResult: result,
      checksum: verifiedAfter.checksum,
      dataChecksum: verifiedAfter.dataChecksum,
      summary: verifiedAfter.summary
    };
  }

  async function loadQueue() {
    if (typeof window._vbIdbGet !== 'function') return [];
    var value = await window._vbIdbGet(QUEUE_KEY);
    return Array.isArray(value) ? value : [];
  }

  async function saveQueue(queue) {
    if (typeof window._vbIdbSet !== 'function') {
      throw new Error('IndexedDB sync queue is unavailable');
    }
    var saved = await window._vbIdbSet(QUEUE_KEY, queue);
    if (!saved) throw new Error('Could not persist SQL offline sync queue');
    var currentDestination = connectionId(getConfig());
    setStatus({ pending: queue.filter(function (queued) {
      return queued && queued.connectionId === currentDestination;
    }).length });
    return queue;
  }

  async function enqueueSnapshot(config, prepared) {
    var queue = await loadQueue();
    var destination = connectionId(config);
    var duplicate = queue.some(function (item) {
      return item && item.connectionId === destination && item.dataChecksum === prepared.dataChecksum;
    });
    if (duplicate) return queue;
    var item = {
      id: prepared.dataChecksum,
      connectionId: destination,
      provider: config.provider,
      idempotencyKey: 'vasoolbook-' + destination + '-' + prepared.dataChecksum,
      createdAt: new Date().toISOString(),
      checksum: prepared.checksum,
      dataChecksum: prepared.dataChecksum,
      size: prepared.size,
      summary: prepared.summary,
      manifest: prepared.manifest,
      data: prepared.data
    };
    // Each item is a complete immutable-ledger snapshot. The latest snapshot
    // supersedes an older unsent snapshot while retaining all historical rows.
    queue = queue.filter(function (queued) {
      return queued && queued.connectionId !== destination;
    });
    queue.push(item);
    await saveQueue(queue);
    return queue;
  }

  async function saveSuccessfulManifest(item, response, applied) {
    var manifest = {
      syncedAt: new Date().toISOString(),
      serverRevision: String(response.serverRevision || response.revision || ''),
      checksum: applied && applied.checksum || item.checksum,
      dataChecksum: applied && applied.dataChecksum || item.dataChecksum,
      summary: applied && applied.summary || item.summary,
      manifest: item.manifest,
      connectionId: item.connectionId || ''
    };
    if (typeof window._vbIdbSet === 'function') {
      var saved = await window._vbIdbSet(MANIFEST_KEY, manifest);
      if (!saved) throw new Error('Could not save successful SQL sync manifest');
    }
    return manifest;
  }

  async function sendQueueItem(config, item) {
    var currentStatus = getStatus();
    var currentRevision = currentStatus.provider === config.provider
      && (!currentStatus.connectionId || currentStatus.connectionId === connectionId(config))
      ? currentStatus.serverRevision : '';
    var response = await requestJson(config, '/v1/sql/sync', {
      method: 'POST',
      timeoutMs: SYNC_TIMEOUT_MS,
      headers: Object.assign({
        'X-Idempotency-Key': item.idempotencyKey
      }, currentRevision ? {
        'If-Match': currentRevision
      } : {}),
      body: {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'merge',
        atomic: true,
        provider: config.provider,
        database: config.database,
        baseRevision: currentRevision || null,
        idempotencyKey: item.idempotencyKey,
        checksum: item.checksum,
        dataChecksum: item.dataChecksum,
        size: item.size,
        summary: item.summary,
        manifest: item.manifest,
        snapshot: item.data
      }
    });
    if (response.conflicts && response.conflicts.length) {
      var conflictError = new Error(
        response.conflicts.length + ' backend conflict(s); local data was not changed'
      );
      conflictError.code = 'backend_conflict';
      conflictError.conflicts = response.conflicts;
      throw conflictError;
    }
    if (response.integrity && response.integrity.valid === false) {
      throw new Error(response.integrity.message || 'Backend integrity verification failed');
    }
    var accepted = String(response.acceptedDataChecksum || response.dataChecksum || '');
    if (!accepted || accepted.toLowerCase() !== String(item.dataChecksum).toLowerCase()) {
      throw new Error('Backend did not acknowledge the uploaded data checksum');
    }
    var applied = null;
    if (response.snapshot || response.remoteSnapshot) {
      if (!(response.snapshotChecksum || response.remoteChecksum)) {
        throw new Error('Backend merged snapshot checksum is missing');
      }
      applied = await applyServerSnapshot(
        response.snapshot || response.remoteSnapshot,
        response.snapshotChecksum || response.remoteChecksum || ''
      );
    }
    return {
      response: response,
      applied: applied
    };
  }

  async function flushQueue(config) {
    if (!cloudDatabaseEnabled()) return disabledResult('queue-upload', config);
    if (!navigator.onLine) {
      var offlineQueue = await loadQueue();
      var offlineDestination = connectionId(config);
      var offlinePending = offlineQueue.filter(function (queued) {
        return queued && queued.connectionId === offlineDestination;
      }).length;
      setStatus({
        state: 'queued',
        message: 'Offline. Sync is queued safely.',
        pending: offlinePending,
        connectionId: offlineDestination
      });
      return { queued: true, pending: offlinePending };
    }
    var queue = await loadQueue();
    var destination = connectionId(config);
    var itemIndex = queue.findIndex(function (queued) {
      return queued && queued.connectionId === destination;
    });
    if (itemIndex < 0) return { queued: false, pending: 0, empty: true };
    var item = queue[itemIndex];
    try {
      var sent = await sendQueueItem(config, item);
      var manifest = await saveSuccessfulManifest(item, sent.response, sent.applied);
      queue.splice(itemIndex, 1);
      await saveQueue(queue);
      setStatus({
        state: 'synchronized',
        provider: config.provider,
        connectionId: destination,
        message: 'Sync completed and verified',
        pending: queue.filter(function (queued) { return queued.connectionId === destination; }).length,
        conflicts: 0,
        serverRevision: manifest.serverRevision,
        lastSync: manifest.syncedAt,
        dataChecksum: manifest.dataChecksum,
        summary: manifest.summary
      });
      return {
        queued: false,
        pending: queue.filter(function (queued) { return queued.connectionId === destination; }).length,
        manifest: manifest,
        response: sent.response
      };
    } catch (error) {
      var retained = await loadQueue();
      var retainedPending = retained.filter(function (queued) {
        return queued && queued.connectionId === destination;
      }).length;
      setStatus({
        state: error && error.conflicts ? 'conflict' : 'queued',
        message: error.message + '. Local data and queued snapshot were preserved.',
        pending: retainedPending,
        conflicts: error && error.conflicts ? error.conflicts.length : 0
      });
      error.queuePreserved = true;
      throw error;
    }
  }

  async function stageLocalBackupFallback(prepared, reason) {
    if (typeof window._vbIdbSet !== 'function') {
      throw new Error('IndexedDB backup fallback is unavailable');
    }
    var fallback = {
      connectionId: reason && reason.connectionId || '',
      provider: reason && reason.provider || '',
      reason: reason && reason.reason || 'before-database-backup',
      createdAt: new Date().toISOString(),
      checksum: prepared.checksum,
      dataChecksum: prepared.dataChecksum,
      size: prepared.size,
      summary: prepared.summary,
      data: prepared.data
    };
    if (!await window._vbIdbSet(BACKUP_FALLBACK_KEY, fallback)) {
      throw new Error('Verified local backup fallback could not be saved');
    }
    return fallback;
  }

  function verifyAcknowledgedChecksum(response, expected) {
    var accepted = String(response && (
      response.acceptedDataChecksum || response.dataChecksum || response.checksum
    ) || '').toLowerCase();
    if (!accepted || accepted !== String(expected || '').toLowerCase()) {
      throw new Error('Backend did not acknowledge the verified data checksum');
    }
    if (response.integrity && response.integrity.valid === false) {
      throw new Error(response.integrity.message || 'Backend integrity verification failed');
    }
    return true;
  }

  async function backupToServer(config) {
    var prepared = await prepareSnapshot();
    await stageLocalBackupFallback(prepared, {
      connectionId: connectionId(config), provider: config.provider, reason: 'before-database-cloud-backup'
    });
    if (!navigator.onLine) {
      throw new Error('Offline. A verified local fallback was retained; cloud backup was not attempted');
    }
    var idempotencyKey = 'vasoolbook-backup-' + connectionId(config) + '-' + prepared.dataChecksum;
    var response = await requestJson(config, '/v1/sql/backup', {
      method: 'POST',
      timeoutMs: SYNC_TIMEOUT_MS,
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: {
        protocolVersion: PROTOCOL_VERSION,
        operation: 'backup',
        readOnlyLocal: true,
        provider: config.provider,
        database: config.database,
        idempotencyKey: idempotencyKey,
        checksum: prepared.checksum,
        dataChecksum: prepared.dataChecksum,
        size: prepared.size,
        summary: prepared.summary,
        manifest: prepared.manifest,
        snapshot: prepared.data
      }
    });
    verifyAcknowledgedChecksum(response, prepared.dataChecksum);
    setStatus({
      state: 'connected', provider: config.provider, connectionId: connectionId(config),
      message: 'Backup uploaded and checksum verified', lastBackup: new Date().toISOString(),
      dataChecksum: prepared.dataChecksum,
      serverRevision: String(response.serverRevision || response.revision || getStatus().serverRevision || '')
    });
    return { response: response, summary: prepared.summary, checksum: prepared.dataChecksum };
  }

  async function restoreFromServer(config) {
    if (!navigator.onLine) throw new Error('Restore requires an online connection');
    var response = await requestJson(config, '/v1/sql/restore/preview', {
      method: 'GET', timeoutMs: SYNC_TIMEOUT_MS
    });
    var remoteSnapshot = response.snapshot || response.backup || response.data;
    var remoteChecksum = response.snapshotChecksum || response.checksum || '';
    var remote = await verifyRemoteSnapshot(remoteSnapshot, remoteChecksum);
    var localPrepared = await prepareSnapshot();
    var remotePrepared = await prepareSnapshot(remote);
    var previewMerge = mergePayloads(localPrepared.data, remotePrepared.data);
    if (previewMerge.conflicts.length) {
      var conflictError = new Error(
        previewMerge.conflicts.length + ' unresolved financial conflict(s); restore was not started'
      );
      conflictError.code = 'financial_conflict';
      conflictError.conflicts = previewMerge.conflicts;
      throw conflictError;
    }
    var mergedPrepared = await prepareSnapshot(previewMerge.data);
    ['customers', 'borrowers', 'payments', 'areas', 'reports'].forEach(function (name) {
      if (mergedPrepared.summary[name] < Math.max(localPrepared.summary[name], remotePrepared.summary[name])) {
        throw new Error('Restore preview integrity failed: ' + name + ' count decreased');
      }
    });
    var message = 'Verified Database Restore Preview\n\n' +
      'Provider: ' + providerLabel(config.provider) + '\n' +
      'Current borrowers/loans: ' + localPrepared.summary.borrowers + '\n' +
      'Backup borrowers/loans: ' + remotePrepared.summary.borrowers + '\n' +
      'Current payments/history: ' + localPrepared.summary.payments + '\n' +
      'Backup payments/history: ' + remotePrepared.summary.payments + '\n' +
      'Merged borrowers/loans: ' + mergedPrepared.summary.borrowers + '\n' +
      'Merged payments/history: ' + mergedPrepared.summary.payments + '\n' +
      'Checksum: ' + remotePrepared.dataChecksum.slice(0, 16) + '...\n\n' +
      'Merge this backup? Newer local records are preserved. Cancel keeps all local data unchanged.';
    if (!window.confirm(message)) return { cancelled: true, preview: true };
    var applied = await applyServerSnapshot(remotePrepared.data, remotePrepared.checksum);
    setStatus({
      state: 'connected', provider: config.provider, connectionId: connectionId(config),
      message: 'Restore merged and validated atomically', lastRestore: new Date().toISOString(),
      dataChecksum: applied.dataChecksum
    });
    return { restored: true, applied: applied, remote: remotePrepared.summary };
  }

  function adapter(config) {
    config = validateConfig(config);
    return {
      connect: async function (tokenInput) {
        if (!cloudDatabaseEnabled()) return disabledResult('connect', config);
        var token = normalizeAccessToken(tokenInput, false) || await readAccessToken(config);
        token = normalizeAccessToken(token, true);
        var result = await requestJson(config, '/v1/sql/connect', {
          method: 'POST',
          body: {
            protocolVersion: PROTOCOL_VERSION,
            provider: config.provider,
            database: config.database,
            username: config.username || null,
            appVersion: typeof window.APP_VERSION_NAME !== 'undefined'
              ? window.APP_VERSION_NAME : ''
          }
        }, token);
        var sessionToken = String(result.sessionToken || result.accessToken || token);
        await saveAccessToken(config, sessionToken);
        setStatus({
          state: 'connected',
          provider: config.provider,
          connectionId: connectionId(config),
          message: result.message || 'Secure backend connected',
          serverRevision: String(result.serverRevision || result.revision || ''),
          credentialExpiresAt: result.expiresAt || result.expiry || '',
          credentialType: result.sessionToken || result.accessToken
            ? 'scoped-gateway-token'
            : (config.provider === 'firebase' ? 'firebase-id-token' : 'scoped-gateway-token'),
          lastError: ''
        });
        return result;
      },
      test: async function () {
        if (!cloudDatabaseEnabled()) return disabledResult('test', config);
        var result = await requestJson(config, '/v1/sql/health', {
          method: 'GET'
        });
        if (result.integrity && result.integrity.valid === false) {
          throw new Error(result.integrity.message || 'Backend integrity test failed');
        }
        setStatus({
          state: 'connected',
          provider: config.provider,
          connectionId: connectionId(config),
          message: result.message || 'Connection and database test passed',
          lastTest: new Date().toISOString(),
          serverRevision: String(result.serverRevision || result.revision || getStatus().serverRevision || ''),
          lastError: ''
        });
        return result;
      },
      diagnostics: async function () {
        if (!cloudDatabaseEnabled()) return disabledResult('diagnostics', config);
        var queue = await loadQueue();
        var destination = connectionId(config);
        var report = {
          provider: providerLabel(config.provider),
          gatewayUrl: config.apiUrl,
          gatewayUrlValid: true,
          database: config.database,
          secureStorage: secureStorageStatus(),
          token: 'Missing',
          pendingQueue: queue.filter(function (queued) {
            return queued && queued.connectionId === destination;
          }).length,
          lastSyncError: getStatus().lastError || '',
          request: 'Not run'
        };
        var token = await readAccessToken(config);
        if (!token) {
          report.request = 'Not run: Gateway Access Token is missing';
          return report;
        }
        report.token = 'Present (' + token.slice(0, 4) + '...' + token.slice(-4) + ')';
        try {
          await requestJson(config, '/v1/sql/health', { method: 'GET' });
          report.request = 'HTTP 200: Gateway health request passed';
        } catch (error) {
          report.request = requestErrorDetail(error);
        }
        return report;
      },
      sync: async function () {
        if (!cloudDatabaseEnabled()) return disabledResult('sync', config);
        var prepared = await prepareSnapshot();
        await enqueueSnapshot(config, prepared);
        if (!navigator.onLine) {
          setStatus({
            state: 'queued',
            provider: config.provider,
            connectionId: connectionId(config),
            message: 'Offline. Full verified snapshot queued.',
            pending: 1,
            dataChecksum: prepared.dataChecksum
          });
          return { queued: true, pending: 1 };
        }
        return flushQueue(config);
      },
      status: async function () {
        if (!cloudDatabaseEnabled()) return disabledResult('status', config);
        var queue = await loadQueue();
        var local = getStatus();
        var destination = connectionId(config);
        var pending = queue.filter(function (queued) {
          return queued && queued.connectionId === destination;
        }).length;
        if (!navigator.onLine) {
          return Object.assign({}, local, {
            online: false,
            pending: pending,
            message: 'Offline. Local sync queue is safe.'
          });
        }
        var remote = await requestJson(config, '/v1/sql/status', { method: 'GET' });
        var status = setStatus({
          state: remote.state || local.state || 'connected',
          provider: config.provider,
          connectionId: destination,
          message: remote.message || local.message || 'Status received',
          pending: pending,
          serverRevision: String(remote.serverRevision || remote.revision || local.serverRevision || ''),
          lastSync: remote.lastSync || local.lastSync || '',
          conflicts: Array.isArray(remote.conflicts) ? remote.conflicts.length : 0
        });
        return Object.assign({}, status, { online: true, remote: remote });
      },
      disconnect: async function () {
        if (!cloudDatabaseEnabled()) return disabledResult('disconnect', config);
        var warning = '';
        try {
          if (navigator.onLine && await readAccessToken(config)) {
            await requestJson(config, '/v1/sql/disconnect', { method: 'POST' });
          }
        } catch (error) {
          warning = error.message;
        } finally {
          await removeAccessToken(config);
          var queue = await loadQueue();
          var destination = connectionId(config);
          setStatus({
            state: 'disconnected',
            provider: config.provider,
            connectionId: connectionId(config),
            message: warning
              ? 'Disconnected locally. Backend notice failed: ' + warning
              : 'Disconnected. Local data and pending queue were not changed.',
            pending: queue.filter(function (queued) {
              return queued && queued.connectionId === destination;
            }).length
          });
        }
        return { disconnected: true, warning: warning };
      },
      backup: function () { return cloudDatabaseEnabled() ? backupToServer(config) : disabledResult('backup', config); },
      restore: function () { return cloudDatabaseEnabled() ? restoreFromServer(config) : disabledResult('restore', config); }
    };
  }

  function injectStyles() {
    if (el('vb-sql-style')) return;
    var style = document.createElement('style');
    style.id = 'vb-sql-style';
    style.textContent =
      '#vb-sql-modal{display:none;position:fixed;inset:0;z-index:9910;background:rgba(0,0,0,.62);align-items:flex-end;justify-content:center;padding-top:env(safe-area-inset-top)}' +
      '#vb-sql-modal.open{display:flex}' +
      '.vb-sql-sheet{width:100%;max-width:520px;max-height:94dvh;overflow:auto;background:#f5f7fa;border-radius:18px 18px 0 0;padding-bottom:calc(14px + env(safe-area-inset-bottom));font-family:Poppins,sans-serif}' +
      '.vb-sql-head{position:sticky;top:0;z-index:2;background:#174f3d;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
      '.vb-sql-close{width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.18);color:#fff;font-size:19px}' +
      '.vb-sql-body{padding:12px}' +
      '.vb-sql-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.vb-sql-field{margin-bottom:9px}' +
      '.vb-sql-field label{display:block;font-size:9px;font-weight:800;color:#667085;text-transform:uppercase;margin:0 0 4px}' +
      '.vb-sql-field input,.vb-sql-field select{width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #dfe5ee;border-radius:8px;background:#fff;font:600 11px Poppins,sans-serif;color:#1a1a2e}' +
      '.vb-sql-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}' +
      '.vb-sql-actions button{min-height:42px;border:0;border-radius:8px;padding:8px 4px;font:800 11px Poppins,sans-serif;background:#e7f1ed;color:#174f3d}' +
      '.vb-sql-actions button.primary{background:#174f3d;color:#fff}' +
      '.vb-sql-actions button.warn{background:#fff3df;color:#a55500}' +
      '.vb-sql-actions button:disabled{opacity:.55}' +
      '#sql-status-panel{background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:10px;margin-top:10px;font-size:10px;line-height:1.6;color:#475467;white-space:pre-wrap}' +
      '@media(max-width:390px){.vb-sql-grid{grid-template-columns:1fr}.vb-sql-actions{grid-template-columns:1fr 1fr}}';
    document.head.appendChild(style);
  }

  function ensureModal() {
    injectStyles();
    var modal = el('vb-sql-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'vb-sql-modal';
    modal.innerHTML =
      '<div class="vb-sql-sheet" onclick="event.stopPropagation()">' +
        '<div class="vb-sql-head"><div><div style="font-size:15px;font-weight:900">Database / Cloud Connection</div><div style="font-size:9px;opacity:.78">Secure gateway sync with atomic data protection</div></div><button class="vb-sql-close" type="button" onclick="VBSQLServer.close()" aria-label="Close">x</button></div>' +
        '<div class="vb-sql-body">' +
          '<div id="sql-mode-banner" style="padding:9px 10px;margin-bottom:9px;border-radius:8px;background:#eaf7f1;color:#174f3d;font-size:10px;font-weight:900">Cloud Database: ON</div>' +
          '<div class="vb-sql-grid">' +
            '<div class="vb-sql-field"><label>Provider</label><select id="sql-provider" onchange="VBSQLServer.providerChanged()"><option value="turso">Turso / libSQL Gateway</option><option value="firebase">Firebase Gateway</option><option value="custom">Custom SQL API</option><option value="vasoolbook">VasoolBook Backend</option><option value="postgres">PostgreSQL Gateway</option><option value="mysql">MySQL Gateway</option><option value="mssql">Microsoft SQL Gateway</option></select></div>' +
            '<div class="vb-sql-field"><label id="sql-database-label">Database name</label><input id="sql-database" autocomplete="off"></div>' +
          '</div>' +
          '<div class="vb-sql-field"><label>Backend API URL</label><input id="sql-api-url" inputmode="url" autocomplete="off" placeholder="https://api.example.com"></div>' +
          '<div class="vb-sql-grid">' +
            '<div class="vb-sql-field"><label>Username</label><input id="sql-username" autocomplete="username"></div>' +
            '<div class="vb-sql-field"><label id="sql-token-label">Gateway access token</label><input id="sql-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Stored with Android Keystore"></div>' +
          '</div>' +
          '<div id="sql-provider-hint" style="padding:8px 10px;margin-bottom:9px;border-radius:8px;background:#fff8e1;color:#725500;font-size:9px;font-weight:700;line-height:1.5"></div>' +
          '<button id="sql-save-config" type="button" onclick="VBSQLServer.saveFromForm()" style="width:100%;padding:11px;border:0;border-radius:8px;background:#e7f1ed;color:#174f3d;font:800 11px Poppins,sans-serif">Save Configuration</button>' +
          '<div class="vb-sql-actions">' +
            '<button class="primary" data-sql-action="connect" onclick="VBSQLServer.run(\'connect\',this)">Connect</button>' +
            '<button data-sql-action="test" onclick="VBSQLServer.run(\'test\',this)">Test</button>' +
            '<button class="primary" data-sql-action="sync" onclick="VBSQLServer.run(\'sync\',this)">Sync</button>' +
            '<button class="primary" data-sql-action="backup" onclick="VBSQLServer.run(\'backup\',this)">Backup</button>' +
            '<button class="warn" data-sql-action="restore" onclick="VBSQLServer.run(\'restore\',this)">Restore</button>' +
            '<button data-sql-action="status" onclick="VBSQLServer.run(\'status\',this)">Status</button>' +
            '<button data-sql-action="diagnostics" onclick="VBSQLServer.run(\'diagnostics\',this)">Diagnostics</button>' +
            '<button class="warn" data-sql-action="disconnect" onclick="VBSQLServer.run(\'disconnect\',this)">Disconnect</button>' +
          '</div>' +
          '<div id="sql-status-panel"></div>' +
        '</div>' +
      '</div>';
    modal.onclick = close;
    document.body.appendChild(modal);
    return modal;
  }

  function fillForm(config) {
    el('sql-provider').value = config.provider;
    el('sql-api-url').value = config.apiUrl || '';
    el('sql-database').value = config.database || '';
    el('sql-username').value = config.username || '';
    el('sql-token').value = '';
    updateProviderFields(config.provider);
  }

  function updateProviderFields(provider) {
    var databaseLabel = el('sql-database-label');
    var database = el('sql-database');
    var tokenLabel = el('sql-token-label');
    var token = el('sql-token');
    var hint = el('sql-provider-hint');
    if (provider === 'turso') {
      if (databaseLabel) databaseLabel.textContent = 'Turso database URL / name';
      if (database) database.placeholder = 'libsql://database-name.turso.io';
      if (tokenLabel) tokenLabel.textContent = 'Gateway access token';
      if (token) token.placeholder = 'Not the Turso database token';
      if (hint) hint.textContent = 'The app calls your HTTPS gateway. Keep the Turso database token in the gateway secret manager only.';
    } else if (provider === 'firebase') {
      if (databaseLabel) databaseLabel.textContent = 'Firebase Project ID';
      if (database) database.placeholder = 'your-firebase-project-id';
      if (tokenLabel) tokenLabel.textContent = 'Firebase ID / gateway token';
      if (token) token.placeholder = 'Short-lived user token';
      if (hint) hint.textContent = 'Use a signed-in user ID token or scoped gateway token. Never paste a service-account key or Firebase Admin credential.';
    } else {
      if (databaseLabel) databaseLabel.textContent = 'Database / tenant name';
      if (database) database.placeholder = 'vasoolbook';
      if (tokenLabel) tokenLabel.textContent = 'Gateway access token';
      if (token) token.placeholder = 'Stored with Android Keystore';
      if (hint) hint.textContent = 'Only an HTTPS API is contacted. Database passwords and client secrets must remain in the server secret manager.';
    }
  }

  function providerChanged() {
    var provider = el('sql-provider').value;
    if (el('sql-token')) el('sql-token').value = '';
    updateProviderFields(provider);
  }

  function formConfig() {
    return {
      provider: el('sql-provider').value,
      apiUrl: el('sql-api-url').value.trim(),
      database: el('sql-database').value.trim(),
      username: el('sql-username').value.trim()
    };
  }

  async function saveFromForm(silent) {
    try {
      var previous = getConfig();
      var config = validateConfig(formConfig());
      var tokenField = el('sql-token');
      var rawToken = String(tokenField && tokenField.value || '');
      if (rawToken && !rawToken.trim()) {
        throw new Error('Gateway Access Token cannot be empty or whitespace.');
      }
      saveConfig(config);
      if (rawToken.trim()) {
        await saveAccessToken(config, rawToken);
        tokenField.value = '';
      }
      var changed = connectionId(previous) !== connectionId(config);
      if (changed) {
        setStatus({
          provider: config.provider,
          connectionId: connectionId(config),
          state: 'configured',
          message: 'Connection configuration changed. Connect with this provider credential.',
          serverRevision: '',
          conflicts: 0
        });
      } else if (!silent) {
        setStatus({
          provider: config.provider,
          connectionId: connectionId(config),
          state: 'configured',
          message: rawToken.trim() ? 'Configuration saved. Gateway token stored securely.' : 'Configuration saved. Token was not stored in app settings.'
        });
        toast('SQL backend configuration saved');
      }
      return config;
    } catch (error) {
      if (!silent) toast(error.message, 'err', 5000);
      return null;
    }
  }

  async function renderStatus(status) {
    var panel = el('sql-status-panel');
    if (!panel) return;
    var queue = await loadQueue();
    var config = getConfig();
    var destination = connectionId(config);
    var pending = queue.filter(function (queued) {
      return queued && queued.connectionId === destination;
    }).length;
    status = status || getStatus();
    panel.textContent =
      'Cloud Database: ' + (cloudDatabaseEnabled() ? 'ON' : 'OFF') + '\n' +
      'Provider: ' + providerLabel(status.provider || getConfig().provider) + '\n' +
      'State: ' + (status.state || 'not configured') + '\n' +
      'Message: ' + (status.message || '-') + '\n' +
      'Pending queue: ' + pending + '\n' +
      'Server revision: ' + (status.serverRevision || '-') + '\n' +
      'Last test: ' + (status.lastTest ? new Date(status.lastTest).toLocaleString() : '-') + '\n' +
      'Last sync: ' + (status.lastSync ? new Date(status.lastSync).toLocaleString() : '-') + '\n' +
      'Last backup: ' + (status.lastBackup ? new Date(status.lastBackup).toLocaleString() : '-') + '\n' +
      'Last restore: ' + (status.lastRestore ? new Date(status.lastRestore).toLocaleString() : '-') + '\n' +
      'Credential expiry: ' + (status.credentialExpiresAt ? new Date(status.credentialExpiresAt).toLocaleString() : '-') + '\n' +
      'Last gateway error: ' + (status.lastError || '-') + '\n' +
      'Conflicts: ' + (status.conflicts || 0) + '\n' +
      'Data checksum: ' + (status.dataChecksum ? status.dataChecksum.slice(0, 16) + '...' : '-');
  }

  function open() {
    var modal = ensureModal();
    fillForm(getConfig());
    refreshConnectionMode();
    renderStatus();
    modal.classList.add('open');
  }

  function close() {
    var modal = el('vb-sql-modal');
    if (modal) modal.classList.remove('open');
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll('[data-sql-action]').forEach(function (button) {
      var localOnlyWhileOff = button.getAttribute('data-sql-action') === 'status'
        || button.getAttribute('data-sql-action') === 'diagnostics';
      button.disabled = !!disabled || (!cloudDatabaseEnabled() && !localOnlyWhileOff);
    });
  }

  function refreshConnectionMode() {
    var enabled = cloudDatabaseEnabled();
    var banner = el('sql-mode-banner');
    if (banner) {
      banner.textContent = 'Cloud Database: ' + (enabled ? 'ON' : 'OFF') + (enabled ? '' : ' - remote calls paused; local data remains active');
      banner.style.background = enabled ? '#eaf7f1' : '#f2f4f7';
      banner.style.color = enabled ? '#174f3d' : '#667085';
    }
    setButtonsDisabled(actionBusy);
    refreshSettingsStatus();
  }

  async function run(action, button) {
    if (actionBusy) return false;
    var permissionAction = action === 'sync' ? 'sync.run' : 'sync.' + action;
    if (!window.VBPermissions || typeof window.VBPermissions.require !== 'function' || !window.VBPermissions.require(permissionAction)) return false;
    if (!cloudDatabaseEnabled()) {
      var skipped = await disabledResult(action, getConfig());
      await renderStatus(skipped);
      refreshConnectionMode();
      toast('Cloud Database Connection is OFF. Local data remains available.');
      return skipped;
    }
    var config = await saveFromForm(true);
    if (!config) {
      toast('Complete the SQL backend configuration first', 'err');
      return false;
    }
    var sql = adapter(config);
    actionBusy = true;
    setButtonsDisabled(true);
    var original = button && button.textContent;
    if (button) button.textContent = action.charAt(0).toUpperCase() + action.slice(1) + '...';
    try {
      var result;
      if (action === 'connect') {
        var enteredToken = el('sql-token').value;
        el('sql-token').value = '';
        result = await withTimeout(sql.connect(enteredToken), 60000, providerLabel(config.provider) + ' connect');
      } else if (action === 'diagnostics') {
        result = await withTimeout(sql.diagnostics(), 60000, providerLabel(config.provider) + ' diagnostics');
        var diagnosticText = [
          'Provider: ' + result.provider,
          'Gateway URL: ' + result.gatewayUrl,
          'Gateway URL valid: ' + (result.gatewayUrlValid ? 'Yes' : 'No'),
          'Secure storage: ' + result.secureStorage,
          'Gateway token: ' + result.token,
          'Pending queue: ' + result.pendingQueue,
          'Request: ' + result.request,
          'Last sync error: ' + (result.lastSyncError || '-')
        ].join('\n');
        var panel = el('sql-status-panel');
        if (panel) panel.textContent = diagnosticText;
        toast('Gateway diagnostics completed');
        return result;
      } else {
        var actionTimeout = action === 'restore' ? 360000
          : (action === 'sync' || action === 'backup' ? 240000 : 60000);
        result = await withTimeout(sql[action](), actionTimeout, providerLabel(config.provider) + ' ' + action);
      }
      if (result && result.cancelled) {
        toast('Database restore cancelled. Local data was not changed.');
        return result;
      }
      await renderStatus(result && result.state ? result : getStatus());
      if (action === 'sync' && result && result.queued) {
        toast('Offline sync queued safely');
      } else {
      toast('Database connection ' + action + ' completed');
      }
      return result;
    } catch (error) {
      if (!cloudDatabaseEnabled() || error && error.code === 'cloud_database_off') {
        var disabled = await disabledResult(action, config);
        await renderStatus(disabled);
        return disabled;
      }
      var queue = await loadQueue();
      var destination = connectionId(config);
      var detail = requestErrorDetail(error);
      setStatus({
        state: error && error.conflicts ? 'conflict' : 'error',
        provider: config.provider,
        connectionId: destination,
        message: detail,
        lastError: detail,
        pending: queue.filter(function (queued) { return queued && queued.connectionId === destination; }).length,
        conflicts: error && error.conflicts ? error.conflicts.length : 0
      });
      await renderStatus();
      toast('Database connection ' + action + ' failed: ' + detail, 'err', 6000);
      return false;
    } finally {
      actionBusy = false;
      setButtonsDisabled(false);
      if (button) button.textContent = original;
    }
  }

  async function reconcileAndFlush(config, reason) {
    if (!cloudDatabaseEnabled()) return disabledResult(reason || 'resume', config);
    var prepared = await prepareSnapshot();
    await enqueueSnapshot(config, prepared);
    if (!navigator.onLine) {
      setStatus({
        state: 'queued',
        provider: config.provider,
        connectionId: connectionId(config),
        message: 'Cloud Database is ON but offline. Latest local snapshot is queued safely.',
        pending: 1,
        dataChecksum: prepared.dataChecksum
      });
      return { queued: true, pending: 1, offline: true };
    }
    return flushQueue(config);
  }

  async function connectionModeChanged(enabled) {
    refreshConnectionMode();
    var config = getConfig();
    if (!enabled) {
      abortRemoteRequests();
      var stopped = await disabledResult('toggle-off', config);
      await renderStatus(stopped);
      return stopped;
    }
    if (!config.apiUrl || !config.database) {
      var configured = setStatus({
        state: 'not configured',
        provider: config.provider,
        message: 'Cloud Database Connection is ON. Configure a secure gateway to sync.'
      });
      await renderStatus(configured);
      return { enabled: true, configured: false };
    }
    try {
      var resumed = await reconcileAndFlush(validateConfig(config), 'toggle-on-reconcile');
      await renderStatus();
      return resumed;
    } catch (error) {
      var queue = await loadQueue();
      setStatus({
        state: 'queued',
        provider: config.provider,
        connectionId: connectionId(config),
        message: 'Cloud Database is ON. Reconciliation is queued safely: ' + requestErrorDetail(error),
        pending: queue.filter(function (item) { return item && item.connectionId === connectionId(config); }).length,
        lastError: requestErrorDetail(error)
      });
      await renderStatus();
      return { enabled: true, queued: true, error: requestErrorDetail(error) };
    }
  }

  async function autoFlush() {
    if (!cloudDatabaseEnabled() || autoFlushBusy || !navigator.onLine) return false;
    var config = getConfig();
    if (!config.apiUrl || !config.database) return false;
    var queue = await loadQueue();
    if (!queue.length) return false;
    autoFlushBusy = true;
    try {
      await reconcileAndFlush(validateConfig(config), 'auto-resume-reconcile');
      await renderStatus();
      return true;
    } catch (error) {
      return false;
    } finally {
      autoFlushBusy = false;
    }
  }

  window.VBSQLServer = {
    open: open,
    close: close,
    saveFromForm: saveFromForm,
    providerChanged: providerChanged,
    run: run,
    diagnostics: function () { return adapter(validateConfig(getConfig())).diagnostics(); },
    adapter: adapter,
    getConfig: getConfig,
    getStatus: getStatus,
    secureStore: secureStore,
    prepareSnapshot: prepareSnapshot,
    mergePayloads: mergePayloads,
    loadQueue: loadQueue,
    flushQueue: flushQueue,
    isConnectionEnabled: cloudDatabaseEnabled,
    refreshConnectionMode: refreshConnectionMode,
    connectionModeChanged: connectionModeChanged,
    reconcileAndFlush: reconcileAndFlush
  };

  window.addEventListener('online', function () {
    if (cloudDatabaseEnabled()) setTimeout(autoFlush, 500);
  });

  document.addEventListener('DOMContentLoaded', function () {
    refreshSettingsStatus();
    refreshConnectionMode();
    renderStatus();
    if (cloudDatabaseEnabled() && navigator.onLine) setTimeout(autoFlush, 1200);
  });
})();
