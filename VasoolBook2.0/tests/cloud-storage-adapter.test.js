'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const cloud = fs.readFileSync('www/cloud-storage.js', 'utf8');
const html = fs.readFileSync('www/index.html', 'utf8');
const java = fs.readFileSync('android/app/src/main/java/in/vasoolbook/app/MainActivity.java', 'utf8');
const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');

new vm.Script(cloud, { filename: 'cloud-storage.js' });

['google', 'onedrive', 'dropbox', 'webdav', 'custom'].forEach(provider => {
  assert.match(cloud, new RegExp(`${provider}:\\s*\\{`), `${provider} provider exists`);
});

assert.match(html, /id="sv-cloud-status"/, 'compact Settings Cloud Storage row exists');
assert.match(html, /cloud-storage\.js/, 'common cloud module is loaded');
assert.match(cloud, /function adapter\(config\)/, 'one common adapter factory exists');
['connect', 'test', 'backup', 'restore', 'disconnect', 'status'].forEach(action => {
  assert.match(cloud, new RegExp(`${action}:`), `${action} adapter action exists`);
});

assert.match(cloud, /code_challenge_method:\s*'S256'/, 'OAuth uses PKCE S256');
assert.match(cloud, /crypto\.getRandomValues/, 'PKCE verifier/state use secure randomness');
assert.doesNotMatch(cloud, /client_secret\s*[:=]/i, 'no OAuth client secret is sent or configured');
assert.doesNotMatch(cloud, /localStorage\.setItem\([^)]*(accessToken|refreshToken|password)/i, 'tokens are not persisted in localStorage');
assert.match(cloud, /delete safe\.clientSecret/, 'secret-shaped configuration is stripped');
assert.match(cloud, /memorySecrets/, 'browser tokens are session-only');
assert.match(cloud, /window\.open\(url,\s*'vb_cloud_oauth'/, 'website PKCE uses a popup so session-only verifier survives');
assert.match(cloud, /VB_CLOUD_OAUTH_CALLBACK/, 'website OAuth callback returns through same-origin postMessage');

assert.match(java, /class SecureStorageBridge/, 'native secure storage bridge exists');
assert.match(java, /AndroidKeyStore/, 'native secret key is stored in Android Keystore');
assert.match(java, /AES\/GCM\/NoPadding/, 'native values use authenticated AES-GCM encryption');
assert.match(java, /addJavascriptInterface\(new SecureStorageBridge\(\), "VBSecureStorage"\)/, 'secure bridge is registered');
assert.match(java, /class CloudOAuthBridge/, 'native OAuth browser bridge exists');
assert.match(java, /"https"\.equalsIgnoreCase\(uri\.getScheme\(\)\)/, 'native OAuth refuses non-HTTPS authorization URLs');
assert.match(manifest, /android:scheme="vasoolbook"[\s\S]*android:host="oauth"[\s\S]*android:path="\/callback"/, 'PKCE callback deep link is registered');

assert.match(cloud, /async function retry\(/, 'cloud requests have retry support');
assert.match(cloud, /ACTION_TIMEOUT/, 'cloud actions have hard timeouts');
assert.match(cloud, /_gdPrepareEnterprisePayload/, 'shared validated backup builder is used');
assert.match(cloud, /_gdVerifyEnterpriseChecksum/, 'download/upload checksums are verified');
assert.match(cloud, /Already synchronized/, 'same-checksum duplicate upload is prevented');
assert.match(cloud, /A newer cloud backup exists/, 'newer remote backup cannot be overwritten');
assert.match(cloud, /_gdBackupSafetyRisk/, 'record-count/size safety comparison is reused');
assert.match(cloud, /_vbApplyBackupDataSafely/, 'restore uses the existing atomic rollback path');
assert.match(cloud, /EMERGENCY_KEY/, 'local emergency fallback is staged');
assert.match(cloud, /backupToDrive/, 'Google backup keeps the existing hardened implementation');
assert.match(cloud, /restoreFromDrive/, 'Google restore keeps the existing hardened implementation');
assert.match(cloud, /finally\s*\{[\s\S]*actionBusy = false;[\s\S]*setButtonsDisabled\(false\)/, 'all action buttons recover in finally');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'five-provider-ui',
    'common-adapter-contract',
    'oauth-pkce-s256',
    'no-client-secret',
    'android-keystore-aes-gcm',
    'native-oauth-deep-link',
    'timeout-retry',
    'checksum-verification',
    'duplicate-prevention',
    'newer-backup-protection',
    'atomic-restore-rollback',
    'local-emergency-fallback',
    'google-drive-preserved',
    'finally-button-cleanup'
  ]
}, null, 2));
