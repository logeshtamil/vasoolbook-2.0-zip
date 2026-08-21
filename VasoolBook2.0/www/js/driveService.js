/**
 * driveService.js
 * ─────────────────────────────────────────────────────────────────────────
 * Standalone Google Drive service for VasoolBook (native Google Sign-In edition).
 *
 * STATUS: NOT CONNECTED. This file is self-contained and is not loaded by, or
 * referenced from, www/index.html. Nothing in the app calls it yet. It mirrors
 * the same approach already used inline in index.html (native
 * @codetrix-studio/capacitor-google-auth for the token + the Drive v3 REST API
 * for file storage), packaged as a standalone module for a future wiring step.
 *
 * Requires, once actually connected:
 *   - www/js/vendor/capacitor-google-auth.js loaded first (registers
 *     window.Capacitor.Plugins.GoogleAuth)
 *   - capacitor.config.js → plugins.GoogleAuth.serverClientId configured
 *   - android/app/src/main/res/values/strings.xml → server_client_id configured
 *
 * Public API:
 *   DriveService.getAccessToken(mode)   → Promise<string>
 *   DriveService.upload(fileName, content, options) → Promise<fileMetadata>
 *   DriveService.download(fileName)     → Promise<parsedContent | null>
 * ─────────────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  var TOKEN_TIMEOUT_MS = 25000; // covers native sign-in sheet hangs that never resolve
  var FILES_URL = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

  var _token = null;
  var _authInitialized = false;

  function _log(stage, ok, detail) {
    var line = '[DriveService] ' + stage + (detail ? ' \u2014 ' + detail : '');
    if (ok) { console.log(line); } else { console.warn(line); }
  }

  function _plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.GoogleAuth) || null;
  }

  // One-time native plugin initialization (required before signIn/signOut/refresh).
  function _initAuth() {
    if (_authInitialized) return Promise.resolve();
    var GoogleAuth = _plugin();
    if (!GoogleAuth) return Promise.reject(new Error('Native Google Sign-In plugin is unavailable on this build.'));
    return GoogleAuth.initialize().then(function () {
      _authInitialized = true;
      _log('initialize', true, 'native plugin initialized');
    }).catch(function (e) {
      _log('initialize', false, e && e.message);
      throw e;
    });
  }

  /**
   * getAccessToken(mode)
   * mode: 'interactive' (default) shows the native account chooser / consent screen.
   *       'silent' NEVER shows UI — resolves only if a previous session can be
   *       restored, and rejects (without any prompt) otherwise.
   * Resolves with a Drive-scoped OAuth access token (string). Caches the token
   * in-memory for reuse until a 401 forces a refresh (see _authFetch below).
   */
  function getAccessToken(mode) {
    mode = (mode === 'silent') ? 'silent' : 'interactive';
    return new Promise(function (resolve, reject) {
      if (_token) { resolve(_token); return; }
      _initAuth().then(function () {
        var GoogleAuth = _plugin();
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('Sign-in did not respond in time. Please try again.'));
        }, TOKEN_TIMEOUT_MS);

        var attempt = (mode === 'silent') ? GoogleAuth.refresh() : GoogleAuth.signIn();
        attempt.then(function (result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var token = result && result.authentication && result.authentication.accessToken;
          if (!token) {
            reject(new Error('Google Sign-In did not return an access token.'));
            return;
          }
          _token = token;
          _log('getAccessToken', true, 'mode=' + mode);
          resolve(_token);
        }).catch(function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var msg = (e && e.message) || (e && e.code) || 'Google Sign-In failed.';
          _log('getAccessToken', false, msg);
          reject(e instanceof Error ? e : new Error(msg));
        });
      }).catch(reject);
    });
  }

  // Internal: fetch wrapper that attaches the bearer token and retries once,
  // with a forced fresh token, on a 401 (expired/revoked token). Tries a silent
  // (no-UI) token first so a returning user is never shown an unexpected prompt;
  // falls back to interactive only if no restorable session exists.
  function _authFetch(url, opts, isRetry) {
    opts = opts || {};
    var tokenPromise = getAccessToken('silent').catch(function () {
      return getAccessToken('interactive');
    });
    return tokenPromise.then(function (token) {
      var headers = {};
      for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
      headers.Authorization = 'Bearer ' + token;
      var finalOpts = {};
      for (var k2 in opts) finalOpts[k2] = opts[k2];
      finalOpts.headers = headers;

      return fetch(url, finalOpts).then(function (resp) {
        if (resp.status === 401 && !isRetry) {
          _token = null; // discard the stale token and retry exactly once
          return _authFetch(url, opts, true);
        }
        return resp;
      });
    });
  }

  // Internal: locate a Drive file by exact name. space: 'drive' (default, visible
  // app-created files) or 'appDataFolder' (hidden per-app storage).
  function _findFile(fileName, space) {
    space = space || 'drive';
    var safeName = fileName.replace(/'/g, "\\'");
    var q = encodeURIComponent("name='" + safeName + "' and trashed=false");
    var url = FILES_URL + '?q=' + q + '&fields=files(id,name,modifiedTime,size)&spaces=' + space + '&pageSize=1';
    return _authFetch(url, { method: 'GET' }).then(function (resp) {
      if (!resp.ok) throw new Error('Drive lookup failed: HTTP ' + resp.status);
      return resp.json();
    }).then(function (data) {
      return (data && data.files && data.files[0]) || null;
    });
  }

  /**
   * upload(fileName, content, options)
   * content: a JS object (JSON.stringify'd automatically) or a raw string.
   * options.mimeType: defaults to 'application/json'.
   * options.space: 'drive' (default, visible app-created files) or
   *   'appDataFolder' (hidden per-app storage, not visible in the user's
   *   regular Drive UI — requires the drive.appdata OAuth scope).
   * Creates the file if none exists with that name in that space, otherwise
   * updates the existing file in place (single-fixed-filename backup model).
   * Resolves with the Drive file metadata ({ id, name, ... }).
   */
  function upload(fileName, content, options) {
    options = options || {};
    var mimeType = options.mimeType || 'application/json';
    var space = options.space || 'drive';
    var body = (typeof content === 'string') ? content : JSON.stringify(content);

    return _findFile(fileName, space).then(function (existing) {
      var boundary = 'vbdrive-' + Date.now();
      var metadataPart = existing
        ? {}
        : (space === 'appDataFolder'
          ? { name: fileName, mimeType: mimeType, parents: ['appDataFolder'] }
          : { name: fileName, mimeType: mimeType });
      var multipartBody =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadataPart) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: ' + mimeType + '\r\n\r\n' +
        body + '\r\n' +
        '--' + boundary + '--';

      var url = existing
        ? UPLOAD_URL + '/' + existing.id + '?uploadType=multipart'
        : UPLOAD_URL + '?uploadType=multipart';
      var method = existing ? 'PATCH' : 'POST';

      return _authFetch(url, {
        method: method,
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: multipartBody
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) {
            throw new Error('Drive upload failed: HTTP ' + resp.status + ' ' + t.substring(0, 200));
          });
        }
        return resp.json();
      }).then(function (meta) {
        _log('upload', true, fileName + ' [' + space + ']' + (existing ? ' (updated)' : ' (created)'));
        return meta;
      });
    });
  }

  /**
   * download(fileName, options)
   * options.space: 'drive' (default) or 'appDataFolder' — must match the space
   *   the file was uploaded to.
   * Resolves with the parsed JSON content of the file if it parses as JSON,
   * otherwise the raw text content. Resolves with null if no file with that
   * name exists in that space (caller decides how to treat "no backup yet").
   */
  function download(fileName, options) {
    options = options || {};
    var space = options.space || 'drive';
    return _findFile(fileName, space).then(function (existing) {
      if (!existing) { _log('download', true, fileName + ' [' + space + '] not found'); return null; }
      var url = FILES_URL + '/' + existing.id + '?alt=media';
      return _authFetch(url, { method: 'GET' }).then(function (resp) {
        if (!resp.ok) throw new Error('Drive download failed: HTTP ' + resp.status);
        return resp.text();
      }).then(function (text) {
        _log('download', true, fileName + ' [' + space + ']');
        try { return JSON.parse(text); }
        catch (e) { return text; }
      });
    });
  }

  global.DriveService = {
    getAccessToken: getAccessToken,
    upload: upload,
    download: download
  };

})(window);
