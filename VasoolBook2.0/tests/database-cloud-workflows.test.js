'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/sql-server.js', 'utf8');
const storage = new Map();
const idb = new Map();
const requests = [];
let cloudDatabaseEnabled = true;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = text => crypto.createHash('sha256').update(String(text)).digest('hex');

let localState = {
  backupVersion:4,schemaVersion:7,
  customers:[{id:'C1',name:'Local'}],
  loanProfiles:[{id:'L1',customerId:'C1',recordVersion:1,updatedAt:'2026-07-01T00:00:00Z',loan:10000}],
  entryLog:[{id:'P1',bid:'L1',recordVersion:1,updatedAt:'2026-07-02T00:00:00Z',today:1000}],
  areas:[{id:'A1',name:'Area 1'}],nonAccTxns:[],upiIds:[],expenses:[],reminders:[],collReports:[],
  settings:{pay:'Cash'}
};
const remoteState = clone(localState);
remoteState.customers.push({id:'C2',name:'Remote'});
remoteState.loanProfiles.push({id:'L2',customerId:'C2',recordVersion:1,updatedAt:'2026-07-03T00:00:00Z',loan:20000});
remoteState.entryLog.push({id:'P2',bid:'L2',recordVersion:1,updatedAt:'2026-07-04T00:00:00Z',today:2000});

function response(payload, status = 200) {
  return {ok:status >= 200 && status < 300,status,text:async()=>JSON.stringify(payload)};
}

const documentMock = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  head:{appendChild:()=>{}},body:{appendChild:()=>{}},
  createElement:()=>({style:{},classList:{add(){},remove(){}},setAttribute(){}})
};

const sandbox = {
  console, URL, AbortController, TextEncoder, Uint8Array, Promise, Date, Math, JSON,
  Object, Array, String, Number, Map, Set, setTimeout, clearTimeout,
  navigator:{onLine:true}, document:documentMock,
  localStorage:{
    getItem:key=>storage.has(key)?storage.get(key):null,
    setItem:(key,value)=>storage.set(key,String(value)),
    removeItem:key=>storage.delete(key)
  },
  fetch:async(url,options={})=>{
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({path,headers:options.headers||{},body});
    if (path.endsWith('/connect')) return response({ok:true,sessionToken:'scoped-session',expiresAt:'2099-01-01T00:00:00Z',serverRevision:'1'});
    if (path.endsWith('/health')) return response({ok:true,integrity:{valid:true},serverRevision:'1'});
    if (path.endsWith('/sync')) return response({ok:true,acceptedDataChecksum:body.dataChecksum,integrity:{valid:true},serverRevision:'2'});
    if (path.endsWith('/backup')) return response({ok:true,acceptedDataChecksum:body.dataChecksum,integrity:{valid:true},serverRevision:'3'});
    if (path.endsWith('/restore/preview')) return response({ok:true,snapshot:clone(remoteState),snapshotChecksum:digest(JSON.stringify(remoteState))});
    if (path.endsWith('/status')) return response({ok:true,state:'connected',serverRevision:'3'});
    if (path.endsWith('/disconnect')) return response({ok:true});
    return response({ok:false,message:'Unknown route'},404);
  },
  confirm:()=>true,
  addEventListener:()=>{}
};
sandbox.window = sandbox;
sandbox.window.isCloudDatabaseConnectionEnabled = () => cloudDatabaseEnabled;
sandbox.window.showToast = () => {};
sandbox.window._safeSetItem = (key,value) => storage.set(key,String(value));
sandbox.window._gdSha256 = async text => digest(text);
sandbox.window._gdBuildReadOnlyFullPayload = () => clone(localState);
sandbox.window._gdPrepareEnterprisePayload = async data => ({
  data:clone(data),sha256:digest(JSON.stringify(data)),size:Buffer.byteLength(JSON.stringify(data))
});
sandbox.window._gdVerifyEnterpriseChecksum = async(data,text) => ({sha256:digest(text)});
sandbox.window._vbVerifyBackupPayload = data => {
  if (!data || !Array.isArray(data.loanProfiles) || !Array.isArray(data.entryLog)) throw new Error('Invalid payload');
  return true;
};
sandbox.window._vbNormalizeBackupPayload = clone;
sandbox.window._vbIdbSet = async(key,value) => {idb.set(key,clone(value));return true;};
sandbox.window._vbIdbGet = async key => idb.has(key)?clone(idb.get(key)):null;
sandbox.window._vbApplyBackupDataSafely = async(incoming,label,validate) => {
  const before = clone(localState);
  try {
    localState = clone(incoming);
    await validate(incoming,before);
    return {ok:true,label};
  } catch (error) {
    localState = before;
    throw error;
  }
};

vm.createContext(sandbox);
new vm.Script(source,{filename:'sql-server.js'}).runInContext(sandbox);

async function runProvider(provider,database) {
  const config={provider,apiUrl:'https://gateway.example.com',database,username:'business-user'};
  const adapter=sandbox.VBSQLServer.adapter(config);
  await adapter.connect(provider+'-user-token');
  await adapter.test();
  await adapter.sync();
  await adapter.backup();
  const status=await adapter.status();
  assert.equal(status.state,'connected');
  await adapter.disconnect();
}

(async()=>{
  await runProvider('turso','libsql://vasoolbook-db.example.turso.io');
  await runProvider('firebase','vasool-book-app-08031993');
  await runProvider('custom','vasoolbook');

  const restoreConfig={provider:'custom',apiUrl:'https://gateway.example.com',database:'vasoolbook',username:'business-user'};
  const restoreAdapter=sandbox.VBSQLServer.adapter(restoreConfig);
  await restoreAdapter.connect('custom-user-token');
  sandbox._gdBackupReadOnlyPhase=true;
  const beforeDeferredRestore=clone(localState);
  await assert.rejects(()=>restoreAdapter.restore(),/deferred until the active Google Drive snapshot completes/);
  assert.deepEqual(localState,beforeDeferredRestore,'SQL/Turso restore cannot mutate financial data during Drive snapshot');
  sandbox._gdBackupReadOnlyPhase=false;
  const restored=await restoreAdapter.restore();
  assert.equal(restored.restored,true);
  assert.equal(localState.loanProfiles.length,2,'restore preserves local and adds remote loan');
  assert.equal(localState.entryLog.length,2,'restore preserves complete payment history');
  assert.ok(idb.has('cm_sql_sync_emergency_v1'),'restore creates an emergency snapshot');
  assert.ok(idb.has('cm_sql_backup_fallback_v1'),'backup creates a verified local fallback');

  const authModes=requests.filter(r=>r.path.endsWith('/connect')).map(r=>r.headers['X-VasoolBook-Auth-Mode']);
  assert.ok(authModes.includes('firebase-id-token'),'Firebase Connect identifies the short-lived ID token');
  assert.ok(requests.filter(r=>r.path.endsWith('/backup')).every(r=>r.body.readOnlyLocal===true));
  assert.equal((await sandbox.VBSQLServer.loadQueue()).length,0,'successful sync clears only completed queues');

  const toggleConfig={provider:'custom',apiUrl:'https://gateway.example.com',database:'vasoolbook',username:'business-user'};
  storage.set('cm_sql_server_config_v1',JSON.stringify(toggleConfig));
  const toggleAdapter=sandbox.VBSQLServer.adapter(toggleConfig);
  sandbox.navigator.onLine=false;
  await toggleAdapter.sync();
  const queuedBeforeOff=await sandbox.VBSQLServer.loadQueue();
  const requestsBeforeOff=requests.length;
  const localBeforeOff=clone(localState);
  cloudDatabaseEnabled=false;
  await sandbox.VBSQLServer.connectionModeChanged(false);
  for (const action of ['connect','test','sync','backup','restore','status','diagnostics','disconnect']) {
    const result=action==='connect'
      ? await toggleAdapter[action]('unused-token')
      : await toggleAdapter[action]();
    assert.equal(result.skipped,true,`${action} is skipped while Cloud Database is OFF`);
  }
  assert.equal(requests.length,requestsBeforeOff,'OFF mode performs zero remote requests');
  assert.deepEqual(await sandbox.VBSQLServer.loadQueue(),queuedBeforeOff,'OFF mode preserves the exact pending queue');
  assert.deepEqual(localState,localBeforeOff,'OFF mode does not alter local financial data');

  cloudDatabaseEnabled=true;
  await sandbox.VBSQLServer.connectionModeChanged(true);
  assert.equal(requests.length,requestsBeforeOff,'offline ON resume reconciles locally without a remote request');
  assert.equal((await sandbox.VBSQLServer.loadQueue()).length,1,'offline resume keeps one deduplicated current snapshot');
  sandbox.navigator.onLine=true;
  const onlineResume=await sandbox.VBSQLServer.connectionModeChanged(true);
  assert.equal(requests.length,requestsBeforeOff+1,'online resume uploads exactly one reconciled snapshot: '+JSON.stringify(onlineResume));
  assert.equal((await sandbox.VBSQLServer.loadQueue()).length,0,'verified resumed sync clears only its completed queue item');
  assert.deepEqual(localState,localBeforeOff,'ON resume preserves local financial data');
  delete sandbox.isCloudDatabaseConnectionEnabled;
  storage.set('cm_cfg',JSON.stringify({cloud_database_connection:'0'}));
  assert.equal(sandbox.VBSQLServer.isConnectionEnabled(),false,'OFF setting reloads after app restart');
  storage.set('cm_cfg',JSON.stringify({cloud_database_connection:'1'}));
  assert.equal(sandbox.VBSQLServer.isConnectionEnabled(),true,'ON setting reloads after app restart');
  sandbox.isCloudDatabaseConnectionEnabled=()=>cloudDatabaseEnabled;

  console.log(JSON.stringify({status:'PASS',checks:[
    'turso-connect-test-sync-backup-status-disconnect',
    'firebase-connect-test-sync-backup-status-disconnect',
    'custom-connect-test-sync-backup-status-disconnect',
    'provider-auth-mode','checksum-acknowledgement','offline-idb-contract',
    'restore-preview-confirmation','drive-snapshot-sync-deferral','emergency-snapshot','atomic-history-preservation',
    'cloud-toggle-off-zero-network','cloud-toggle-queue-preserved','cloud-toggle-offline-local-save',
    'cloud-toggle-on-reconcile','cloud-toggle-deduplicated-resume','cloud-toggle-app-restart-persistence'
  ]},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
