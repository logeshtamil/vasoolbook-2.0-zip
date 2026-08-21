const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'www', 'sql-server.js'), 'utf8');
const java = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'in', 'vasoolbook', 'app', 'MainActivity.java'),
  'utf8'
);
const contract = fs.readFileSync(path.join(root, 'docs', 'SQL_SERVER_BACKEND_API.md'), 'utf8');

assert.match(html, /<script src="sql-server\.js" defer><\/script>/, 'SQL module is loaded');
assert.match(html, /Settings|SQL Server/);
assert.match(html, /id="sv-sql-status"/, 'Settings status is present');
assert.match(html, /id="sv-cloud-db-toggle"/, 'Cloud Database ON/OFF toggle is present');
assert.match(html, /cloud_database_connection:'1'/, 'Cloud Database toggle defaults ON and persists in settings');
assert.match(html, /function toggleCloudDatabaseConnection\(\)/, 'Cloud Database toggle handler exists');

for (const provider of ['vasoolbook', 'turso', 'firebase', 'postgres', 'mysql', 'mssql', 'custom']) {
  assert.match(sql, new RegExp(provider), `provider ${provider} is supported through the backend`);
}

for (const action of ['connect', 'test', 'sync', 'backup', 'restore', 'status', 'diagnostics', 'disconnect']) {
  assert.match(sql, new RegExp(`data-sql-action="${action}"`), `${action} action exists`);
}

assert.match(sql, /function adapter\(config\)/, 'one common SQL backend adapter exists');
assert.match(sql, /parsed\.protocol !== 'https:'/, 'HTTPS is mandatory');
assert.match(sql, /Direct database connections are not allowed/, 'direct SQL URLs are rejected');
assert.doesNotMatch(sql, /createConnection\s*\(|DriverManager|new\s+Client\s*\(/, 'no direct database driver exists');

assert.match(sql, /Authorization': 'Bearer '/, 'scoped token uses authorization header');
assert.match(sql, /secureStore\.set\(providerTokenKey\(config\)/, 'token is scoped and stored through secure storage');
assert.match(sql, /async function saveFromForm/, 'save waits for secure token persistence');
assert.match(sql, /await saveAccessToken\(config, rawToken\)/, 'Save Configuration persists the entered gateway token securely');
assert.match(sql, /normalizeAccessToken/, 'token whitespace is trimmed and empty values are rejected');
assert.match(sql, /Use a scoped Gateway Access Token, not a database environment variable/, 'client rejects database environment variables');
assert.doesNotMatch(sql, /localStorage\.setItem\(TOKEN_KEY/, 'token is never stored in localStorage');
assert.doesNotMatch(sql, /TURSO_AUTH_TOKEN/, 'the Turso database environment token is never exposed in client code');
assert.match(sql, /connectionId\(config\)/, 'credentials and queue are scoped to the selected connection');
assert.match(sql, /el\('sql-token'\)\.value = ''/, 'typed token is cleared before the network request');
assert.match(sql, /Do not include tokens or secrets in the API URL/, 'secret-bearing API URLs are rejected');
assert.match(java, /class SecureStorageBridge/, 'Android Keystore bridge remains available');
assert.match(java, /AES\/GCM\/NoPadding/, 'native secrets use authenticated encryption');

assert.match(sql, /QUEUE_KEY = 'cm_sql_sync_queue_v1'/, 'offline queue key exists');
assert.match(sql, /window\._vbIdbSet\(QUEUE_KEY/, 'offline queue is persisted in IndexedDB');
assert.match(sql, /window\.addEventListener\('online'/, 'queued sync resumes when online');
assert.match(sql, /if \(!cloudDatabaseEnabled\(\)\) return disabledResult\('queue-upload', config\)/, 'queue upload is blocked while Cloud Database is OFF');
assert.match(sql, /abortRemoteRequests\(\)/, 'switching OFF cancels in-flight gateway requests');
assert.match(sql, /reconcileAndFlush/, 'switching ON reconciles a fresh local snapshot before upload');
assert.match(sql, /queued\.connectionId === destination/, 'a queue cannot cross provider connections');
assert.match(sql, /X-Idempotency-Key/, 'backend duplicate prevention is required');
assert.match(sql, /If-Match/, 'server revision conflict guard is used');
assert.match(sql, /dataChecksum/, 'business-data checksum is used');
assert.match(sql, /_gdPrepareEnterprisePayload/, 'enterprise SHA-256 payload preparation is reused');

assert.match(sql, /financial_conflict/, 'unresolved financial conflicts stop merge');
assert.match(sql, /Duplicate financial ID has equal version\/time but different data/, 'ambiguous duplicate financial IDs are blocked');
assert.match(sql, /local data was not changed/, 'conflict path is read-only');
assert.match(sql, /stageEmergencySnapshot/, 'emergency snapshot is created before merge');
assert.match(sql, /_vbApplyBackupDataSafely/, 'existing atomic rollback path is reused');
assert.match(
  sql,
  /async function \(incoming, previousState\)[\s\S]*SQL atomic merge validation failed/,
  'atomic validation must inspect the applied live state and throw before commit'
);
assert.match(
  sql,
  /if \(!verifiedAfter\) throw new Error\('SQL atomic merge validation did not run'\)/,
  'sync must reject if the host atomic validation callback was skipped'
);
assert.match(sql, /finally\s*\{[\s\S]*setButtonsDisabled\(false\)/, 'UI buttons reset in finally');
assert.match(sql, /function requestErrorDetail/, 'gateway errors have a safe status formatter');
assert.match(sql, /HTTP ' \+ response\.status/, 'HTTP failures include their exact response status');
assert.match(sql, /lastError: detail/, 'gateway failures are retained for diagnostics');
assert.match(sql, /data-sql-action="diagnostics"/, 'Run Diagnostics action exists');
assert.match(sql, /secureStorage: secureStorageStatus\(\)/, 'diagnostics identifies secure storage availability');
assert.match(sql, /pendingQueue: queue\.filter/, 'diagnostics reports scoped queue count');
assert.match(sql, /MAX_RETRIES = 3/, 'network retry policy exists');
assert.match(sql, /AbortController/, 'network requests have a hard timeout');
assert.match(sql, /stageLocalBackupFallback/, 'database backup has a verified local fallback');
assert.match(sql, /\/v1\/sql\/backup/, 'verified database backup endpoint is used');
assert.match(sql, /\/v1\/sql\/restore\/preview/, 'restore is downloaded as a read-only preview');
assert.match(sql, /if \(!window\.confirm\(message\)\) return \{ cancelled: true, preview: true \}/, 'restore requires explicit confirmation');

for (const dataset of ['customers', 'loanProfiles', 'entryLog', 'areas', 'collReports']) {
  assert.match(sql, new RegExp(`'${dataset}'`), `${dataset} is included in integrity sync`);
}

assert.match(contract, /one transaction/i, 'backend contract requires atomic transaction');
assert.match(contract, /integer paise/i, 'backend contract requires integer money');
assert.match(contract, /reversals\/adjustments/i, 'backend contract requires immutable corrections');
assert.match(contract, /acceptedDataChecksum/, 'backend must acknowledge the client checksum');
assert.match(contract, /Firebase[\s\S]*service-account JSON/i, 'Firebase administrator credentials remain server-side');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'settings-ui',
    'seven-backend-providers',
    'common-adapter',
    'https-only',
    'no-direct-database-connection',
    'secure-token-storage',
    'provider-scoped-credentials',
    'offline-indexeddb-queue',
    'online-resume',
    'provider-scoped-queue',
    'idempotency',
    'revision-conflict-guard',
    'sha256-integrity',
    'financial-conflict-stop',
    'emergency-snapshot',
    'atomic-rollback',
    'verified-backup-restore-preview',
    'timeout-retry-finally',
    'full-financial-datasets',
    'backend-contract'
  ]
}, null, 2));
