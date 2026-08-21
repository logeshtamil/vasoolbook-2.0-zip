// capacitor.config.js
// Native Android Google Sign-In must use the real Web OAuth Client ID as both
// clientId and serverClientId. No placeholder fallback is allowed.
//
// Resolution order:
//   1. GOOGLE_WEB_CLIENT_ID environment variable
//   2. android/local.properties: GOOGLE_WEB_CLIENT_ID=...
//   3. Web OAuth client from android/app/google-services.json

const fs = require('fs');
const path = require('path');

function readLocalProperty(name) {
  const file = path.join(__dirname, 'android', 'local.properties');
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    if (trimmed.slice(0, idx).trim() === name) return trimmed.slice(idx + 1).trim();
  }
  return '';
}

function readGoogleServicesWebClientId() {
  const file = path.join(__dirname, 'android', 'app', 'google-services.json');
  if (!fs.existsSync(file)) return '';
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clients = Array.isArray(json.client) ? json.client : [];
    for (const client of clients) {
      const oauth = Array.isArray(client.oauth_client) ? client.oauth_client : [];
      const web = oauth.find((item) => item && item.client_type === 3 && item.client_id);
      if (web) return web.client_id.trim();
      const other = (((client.services || {}).appinvite_service || {}).other_platform_oauth_client || []);
      const otherWeb = Array.isArray(other)
        ? other.find((item) => item && item.client_type === 3 && item.client_id)
        : null;
      if (otherWeb) return otherWeb.client_id.trim();
    }
  } catch (error) {
    throw new Error(`Could not read android/app/google-services.json: ${error.message}`);
  }
  return '';
}

function requireWebClientId(value) {
  const clientId = (value || '').trim();
  if (!/^[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(
      'Missing GOOGLE_WEB_CLIENT_ID. Add the real Web OAuth Client ID (*.apps.googleusercontent.com) ' +
      'to android/local.properties or replace android/app/google-services.json with one that contains a Web OAuth client.'
    );
  }
  return clientId;
}

const GOOGLE_WEB_CLIENT_ID = requireWebClientId(
  process.env.GOOGLE_WEB_CLIENT_ID ||
  readLocalProperty('GOOGLE_WEB_CLIENT_ID') ||
  readGoogleServicesWebClientId()
);

const ANDROID_KEYSTORE_PATH =
  process.env.ANDROID_KEYSTORE_PATH ||
  readLocalProperty('ANDROID_KEYSTORE_PATH') ||
  'app/keystores/vasoolbook-signing.jks';
const ANDROID_KEYSTORE_PASSWORD =
  process.env.ANDROID_KEYSTORE_PASSWORD ||
  readLocalProperty('ANDROID_KEYSTORE_PASSWORD') ||
  '';
const ANDROID_KEYSTORE_ALIAS =
  process.env.ANDROID_KEYSTORE_ALIAS ||
  readLocalProperty('ANDROID_KEYSTORE_ALIAS') ||
  'vasoolbook';
const ANDROID_KEYSTORE_ALIAS_PASSWORD =
  process.env.ANDROID_KEYSTORE_ALIAS_PASSWORD ||
  readLocalProperty('ANDROID_KEYSTORE_ALIAS_PASSWORD') ||
  ANDROID_KEYSTORE_PASSWORD;

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'in.vasoolbook.app',
  appName: 'VasoolBook 2.0',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    cleartext: false,
    allowNavigation: [
      '*.google.com',
      '*.googleusercontent.com'
    ]
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    buildOptions: {
      releaseType: 'APK',
      signingType: 'jarsigner',
      keystorePath: ANDROID_KEYSTORE_PATH,
      keystorePassword: ANDROID_KEYSTORE_PASSWORD,
      keystoreAlias: ANDROID_KEYSTORE_ALIAS,
      keystoreAliasPassword: ANDROID_KEYSTORE_ALIAS_PASSWORD
    }
  },
  plugins: {
    GoogleAuth: {
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.appdata'
      ],
      clientId: GOOGLE_WEB_CLIENT_ID,
      serverClientId: GOOGLE_WEB_CLIENT_ID,
      forceCodeForRefreshToken: true
    }
  }
};

module.exports = config;
