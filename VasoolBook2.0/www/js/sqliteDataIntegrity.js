(function(root){
  'use strict';
  var C=root.VBSqliteCore;if(!C){console.error('[VBSQLite] core unavailable');return;}
  var ACTIVE_KEY='vb_sqlite_active_v1',WEB_DB_KEY='vb_sqlite_file_v1',EMERGENCY_PREFIX='vb_sqlite_emergency_';
  var adapter=null,active=false,ready=false,persistChain=Promise.resolve(),pendingReason='',migrationReport=null,lastPersistError=null,writeSuspend=0,recoveryLifecycleLog=[];

  function platform(){try{return root.Capacitor&&root.Capacitor.getPlatform?root.Capacitor.getPlatform():'web';}catch(e){return 'web';}}
  function plugin(){try{return root.Capacitor&&root.Capacitor.Plugins&&root.Capacitor.Plugins.CapacitorSQLite;}catch(e){return null;}}
  function valuesOf(result){return result&&Array.isArray(result.values)?result.values:[];}
  function showBlock(text){var d=document.getElementById('vb-sqlite-boot');if(!d){d=document.createElement('div');d.id='vb-sqlite-boot';d.style.cssText='position:fixed;inset:0;z-index:2147483646;background:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Arial,sans-serif;color:#1B3A6B;text-align:center';d.innerHTML='<div style="max-width:440px"><div style="font-size:19px;font-weight:800;margin-bottom:10px">VasoolBook Data Protection</div><div id="vb-sqlite-boot-text" style="font-size:13px;line-height:1.55"></div></div>';document.documentElement.appendChild(d);}var t=document.getElementById('vb-sqlite-boot-text');if(t)t.textContent=text||'Checking local database...';}
  function hideBlock(){var d=document.getElementById('vb-sqlite-boot');if(d)d.remove();}
  function loadScript(src){return new Promise(function(resolve,reject){var s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=function(){reject(new Error('Could not load '+src));};document.head.appendChild(s);});}

  function errorText(e){return String(e&&e.message||e||'Unknown SQLite error');}
  function sleep(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
  function recoveryLog(list,event,database,details){
    var row=Object.assign({timestamp:C.nowIso(),event:event,database:database,retryCount:0},details||{});
    list.push(row);recoveryLifecycleLog.push(row);if(recoveryLifecycleLog.length>500)recoveryLifecycleLog.splice(0,recoveryLifecycleLog.length-500);
    try{console.info('[VBSQLite][RecoveryStage] '+JSON.stringify(row));}catch(e){}
    return row;
  }
  function cancelled(options){return !!(options&&options.signal&&options.signal.aborted);}
  function throwIfCancelled(options){if(cancelled(options)){var e=new Error('Recovery scan cancelled.');e.name='AbortError';throw e;}}

  function NativeAdapter(p,name,options){this.p=p;this.name=name||C.DATABASE_NAME;this.stage=!!(options&&options.stage);this.lifecycle=options&&options.lifecycle||[];this.opened=false;this.managerConnection=false;}
  NativeAdapter.prototype.init=async function(){
    if(this.stage&&this.name===C.DATABASE_NAME)throw new Error('Recovery staging database must not use the production database name.');
    if(!this.stage)try{await this.p.checkConnectionsConsistency({dbNames:[this.name],openModes:['RW']});}catch(e){}
    try{
      await this.p.createConnection({database:this.name,encrypted:false,mode:'no-encryption',version:C.SCHEMA_VERSION,readonly:false});
      this.managerConnection=true;if(this.stage)recoveryLog(this.lifecycle,'staging_database_created',this.name);
    }catch(e){
      if(this.stage)throw e;
      if(!/already|exist|connection/i.test(errorText(e)))throw e;
      this.managerConnection=true;
    }
    if(this.stage&&this.p.isDBExists){
      var exists=await this.p.isDBExists({database:this.name,readonly:false});
      if(exists&&exists.result){await this.releaseManager();var collision=new Error('Fresh recovery staging name already exists.');collision.code='RECOVERY_STAGE_COLLISION';throw collision;}
    }
    await this.p.open({database:this.name,readonly:false});
    this.opened=true;if(this.stage)recoveryLog(this.lifecycle,'connection_opened',this.name);
  };
  NativeAdapter.prototype.execute=function(sql){return this.p.execute({database:this.name,statements:sql,transaction:false,readonly:false});};
  NativeAdapter.prototype.set=function(set){return this.p.executeSet({database:this.name,set:set,transaction:false,readonly:false});};
  NativeAdapter.prototype.query=async function(sql,vals){return valuesOf(await this.p.query({database:this.name,statement:sql,values:vals||[],readonly:false}));};
  NativeAdapter.prototype.begin=function(){return this.execute('BEGIN IMMEDIATE;');};
  NativeAdapter.prototype.commit=function(){return this.execute('COMMIT;');};
  NativeAdapter.prototype.rollback=function(){return this.execute('ROLLBACK;').catch(function(){});};
  NativeAdapter.prototype.persist=function(){return Promise.resolve();};
  NativeAdapter.prototype.reset=async function(){try{await this.p.closeConnection({database:this.name,readonly:false});}catch(e){}await this.p.deleteDatabase({database:this.name});await this.init();};
  NativeAdapter.prototype.releaseManager=async function(){
    try{await this.p.closeConnection({database:this.name,readonly:false});}catch(e){if(!/No available connection|does not exist/i.test(errorText(e)))throw e;}
    this.managerConnection=false;this.opened=false;
  };
  NativeAdapter.prototype.closeHandle=async function(){
    if(this.stage)recoveryLog(this.lifecycle,'statements_and_cursors_released',this.name);
    try{await this.p.close({database:this.name,readonly:false});}catch(e){if(!/No available connection|not open|closed/i.test(errorText(e)))throw e;}
    this.opened=false;
    for(var i=0;i<12;i++){
      try{var status=await this.p.isDBOpen({database:this.name,readonly:false});if(!status||status.result===false){if(this.stage)recoveryLog(this.lifecycle,'connection_closed',this.name);return true;}}
      catch(e){if(/No available connection/i.test(errorText(e))){this.managerConnection=false;if(this.stage)recoveryLog(this.lifecycle,'connection_closed',this.name,{managerEntry:false});return true;}throw e;}
      await sleep(25);
    }
    throw new Error('Timed out waiting for recovery staging connection to close.');
  };
  NativeAdapter.prototype.ensureDeleteConnection=async function(){
    if(this.managerConnection)return;
    await this.p.createConnection({database:this.name,encrypted:false,mode:'no-encryption',version:C.SCHEMA_VERSION,readonly:false});
    this.managerConnection=true;
    if(this.stage)recoveryLog(this.lifecycle,'delete_connection_recreated',this.name);
  };
  NativeAdapter.prototype.destroy=async function(){
    var deleted=false,retries=0,lastError='';
    try{
      await this.closeHandle();
      for(var attempt=0;attempt<3&&!deleted;attempt++){
        retries=attempt;
        try{
          await this.ensureDeleteConnection();
          recoveryLog(this.lifecycle,'delete_requested',this.name,{retryCount:attempt});
          await this.p.deleteDatabase({database:this.name,readonly:false});
          deleted=true;recoveryLog(this.lifecycle,'delete_completed',this.name,{retryCount:attempt});
        }catch(e){
          lastError=errorText(e);recoveryLog(this.lifecycle,'delete_retry',this.name,{retryCount:attempt+1,error:lastError});
          try{await this.closeHandle();}catch(closeError){recoveryLog(this.lifecycle,'close_retry_failed',this.name,{retryCount:attempt+1,error:errorText(closeError)});}
          if(/No available connection/i.test(lastError))this.managerConnection=false;
          if(attempt<2)await sleep(50*(attempt+1));
        }
      }
    }finally{
      try{await this.releaseManager();recoveryLog(this.lifecycle,'manager_connection_released',this.name,{retryCount:retries});}
      catch(e){lastError=lastError||errorText(e);recoveryLog(this.lifecycle,'manager_release_failed',this.name,{retryCount:retries,error:errorText(e)});}
    }
    return {deleted:deleted,released:!this.managerConnection,retryCount:retries,status:deleted?'deleted':'released_delete_deferred',error:lastError};
  };

  function WebAdapter(ephemeral,name,options){this.db=null;this.ephemeral=!!ephemeral;this.name=name||C.DATABASE_NAME;this.stage=!!(options&&options.stage);this.lifecycle=options&&options.lifecycle||[];}
  WebAdapter.prototype.init=async function(){
    if(!root.initSqlJs)await loadScript('js/vendor/sql-asm.js');
    var SQL=await root.initSqlJs({});var bytes=this.ephemeral?null:await root._vbIdbGet(WEB_DB_KEY);
    if(bytes&&!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    this.db=bytes&&bytes.length?new SQL.Database(bytes):new SQL.Database();
    if(this.stage){recoveryLog(this.lifecycle,'staging_database_created',this.name);recoveryLog(this.lifecycle,'connection_opened',this.name);}
  };
  WebAdapter.prototype.execute=function(sql){this.db.run(sql);return Promise.resolve({changes:{changes:this.db.getRowsModified()}});};
  WebAdapter.prototype.set=function(set){var self=this;(set||[]).forEach(function(x){var q=self.db.prepare(x.statement);try{q.run(x.values||[]);}finally{q.free();}});return Promise.resolve({changes:{changes:self.db.getRowsModified()}});};
  WebAdapter.prototype.query=function(sql,vals){var q=this.db.prepare(sql),rows=[];try{q.bind(vals||[]);while(q.step())rows.push(q.getAsObject());}finally{q.free();}return Promise.resolve(rows);};
  WebAdapter.prototype.begin=function(){return this.execute('BEGIN IMMEDIATE;');};
  WebAdapter.prototype.commit=function(){return this.execute('COMMIT;');};
  WebAdapter.prototype.rollback=function(){try{this.db.run('ROLLBACK;');}catch(e){}return Promise.resolve();};
  WebAdapter.prototype.persist=async function(){if(this.ephemeral)return;var bytes=this.db.export(),ok=await root._vbIdbSet(WEB_DB_KEY,bytes);if(!ok)throw new Error('Website SQLite file could not be persisted.');var verify=await root._vbIdbGet(WEB_DB_KEY);if(!verify||verify.length!==bytes.length)throw new Error('Website SQLite file verification failed.');};
  WebAdapter.prototype.reset=async function(){if(this.db)this.db.close();this.db=null;if(!this.ephemeral)await root._vbIdbSet(WEB_DB_KEY,new Uint8Array(0));await this.init();};
  WebAdapter.prototype.destroy=async function(){if(this.db){recoveryLog(this.lifecycle,'statements_and_cursors_released',this.name);this.db.close();this.db=null;recoveryLog(this.lifecycle,'connection_closed',this.name);recoveryLog(this.lifecycle,'delete_requested',this.name);recoveryLog(this.lifecycle,'delete_completed',this.name);}return {deleted:true,released:true,retryCount:0,status:'deleted',error:''};};

  async function createAdapter(){var p=plugin();adapter=p&&platform()!=='web'?new NativeAdapter(p):new WebAdapter();await adapter.init();await adapter.execute(C.SCHEMA_SQL);var fk=await adapter.query('PRAGMA foreign_keys;');if(!fk.length||Number(fk[0].foreign_keys)!==1)throw new Error('PRAGMA foreign_keys=ON could not be verified.');}
  async function setChunks(set,size){size=size||250;for(var i=0;i<set.length;i+=size)await adapter.set(set.slice(i,i+size));}
  async function setChunksOn(target,set,size,options){size=size||250;for(var i=0;i<set.length;i+=size){throwIfCancelled(options);await target.set(set.slice(i,i+size));}}

  function localJson(key,fallback){try{var x=localStorage.getItem(key);return x?JSON.parse(x):fallback;}catch(e){return fallback;}}
  function captureState(){
    var legacy={};try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('cm_stage_')!==0&&k.indexOf('vb_lifetime_license')!==0&&k!=='vb_license_api_base'&&k!=='cm_mum_session'&&k!=='cm_mum_auth_throttle')legacy[k]=localStorage.getItem(k);}}catch(e){}
    var bridged=root.VBStateBridge&&root.VBStateBridge.capture?root.VBStateBridge.capture():{};
    return C.normalizeState({
      customers:bridged.customers||root.customers||[],borrowers:bridged.borrowers||root.borrowers||[],entryLog:bridged.entryLog||root.entryLog||[],areas:bridged.areas||root.areas||[],nonAccTxns:bridged.nonAccTxns||root.nonAccTxns||[],upiIds:bridged.upiIds||root.upiIds||[],
      expenses:bridged.expenses||root.expenses||localJson('cm_expenses',[]),cashBook:bridged.cashBook||root.cashBook||localJson('cm_cashbook',{}),reminders:bridged.reminders||root.reminders||localJson('cm_rem',[]),settings:bridged.settings||root.S||localJson('cm_cfg',{}),collReports:bridged.collReports||root.collReports||localJson('cm_collReports',[]),
      users:localJson('cm_mum_users',[]),session:null,auditLog:localJson('cm_mum_audit',[]),appLock:localJson('vb_app_lock_v1',{}),syncMeta:localJson('cm_sync_meta',{}),backupMetadata:{status:localJson('cm_backup_status',''),drive:localJson('cm_gd_incremental_manifest_v2',{}),localDirty:localStorage.getItem('cm_local_dirty')||localStorage.getItem('vb_local_dirty')||''},legacyLocalStorage:legacy
    });
  }
  function applyState(s){
    s=C.normalizeState(s);if(root.VBStateBridge&&root.VBStateBridge.apply)root.VBStateBridge.apply(s);else{root.customers=s.customers;root.borrowers=s.borrowers;root.entryLog=s.entryLog;root.areas=s.areas;root.nonAccTxns=s.nonAccTxns;root.upiIds=s.upiIds;root.expenses=s.expenses;root.cashBook=s.cashBook;root.reminders=s.reminders;root.S=s.settings;root.collReports=s.collReports;}
    try{localStorage.setItem('cm_cfg',JSON.stringify(s.settings));localStorage.setItem('cm_expenses',JSON.stringify(s.expenses));localStorage.setItem('cm_cashbook',JSON.stringify(s.cashBook));localStorage.setItem('cm_rem',JSON.stringify(s.reminders));localStorage.setItem('cm_collReports',JSON.stringify(s.collReports));localStorage.setItem('cm_mum_users',JSON.stringify(s.users));localStorage.setItem('cm_mum_audit',JSON.stringify(s.auditLog));}catch(e){}
  }

  async function emergencySnapshot(state,reason){
    var payload={type:'sqlite-emergency-snapshot',reason:reason||'migration',createdAt:C.nowIso(),schemaVersion:C.SCHEMA_VERSION,state:state},text=JSON.stringify(payload),sha=await C.sha256(text),key=EMERGENCY_PREFIX+Date.now();
    var ok=await root._vbIdbSetMany((function(){var x={};x[key]=text;x[key+'_meta']=JSON.stringify({sha256:sha,bytes:text.length,counts:C.stateCounts(state),totals:C.stateTotals(state),createdAt:payload.createdAt});return x;})());
    if(!ok)throw new Error('Emergency snapshot write failed. Migration was not started.');
    var read=await root._vbIdbGet(key);if(read!==text||await C.sha256(read)!==sha)throw new Error('Emergency snapshot verification failed. Migration was not started.');
    return {key:key,sha256:sha,bytes:text.length};
  }

  function sourceRows(state,runId){var out=[];var groups={customers:state.customers,borrowers:state.borrowers,entryLog:state.entryLog,areas:state.areas,nonAccTxns:state.nonAccTxns,upiIds:state.upiIds,expenses:state.expenses,reminders:state.reminders,collReports:state.collReports,users:state.users,auditLog:state.auditLog};Object.keys(groups).forEach(function(k){(groups[k]||[]).forEach(function(x,i){var raw=JSON.stringify(x),id=String(x&&(x.id||x.loanProfileId||x.customerId||x.areaId||x.userId)||'');out.push({statement:'INSERT INTO migration_staging(id,source_key,source_index,entity_type,legacy_id,raw_json,row_checksum,migration_run_id) VALUES(?,?,?,?,?,?,?,?)',values:[C.uuid(),k,i,k,id,raw,C.fastHash(C.stableStringify(x)),runId]});});});return out;}
  function entityRows(state,now){var out=[],groups={customers:state.customers,loans:state.borrowers,history:state.entryLog,areas:state.areas,nonAccount:state.nonAccTxns,upi:state.upiIds,expenses:state.expenses,reminders:state.reminders,reports:state.collReports,users:state.users,audit:state.auditLog};Object.keys(groups).forEach(function(kind){(groups[kind]||[]).forEach(function(x,i){var id=String(x&&(x.id||x.loanProfileId||x.customerId||x.areaId||x.userId)||kind+'_'+i),raw=JSON.stringify(x),hash=C.fastHash(C.stableStringify(x));out.push({statement:'INSERT INTO entity_state(entity_type,legacy_id,raw_json,row_checksum,version,created_at,updated_at,deleted_at) VALUES(?,?,?,?,1,?,?,NULL) ON CONFLICT(entity_type,legacy_id) DO UPDATE SET raw_json=excluded.raw_json,row_checksum=excluded.row_checksum,version=entity_state.version+CASE WHEN entity_state.row_checksum<>excluded.row_checksum THEN 1 ELSE 0 END,updated_at=excluded.updated_at,deleted_at=NULL',values:[kind,id,raw,hash,now,now]});});});return out;}

  async function dbMigrationMetrics(source,target){
    target=target||adapter;
    var counts=C.clone(source.counts),q;
    q=await target.query('SELECT COUNT(*) n FROM loans');counts.loans=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM financial_transactions');counts.history=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM areas');counts.areas=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM expenses');counts.expenses=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM non_account_transactions');counts.nonAccount=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM upi_accounts');counts.upi=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM reminders');counts.reminders=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM report_snapshots');counts.reports=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM app_users');counts.users=Number(q[0].n);
    q=await target.query('SELECT COUNT(*) n FROM audit_log');counts.audit=Number(q[0].n);
    var totals={};q=await target.query('SELECT COALESCE(SUM(original_loan_amount_paise),0)n FROM loans');totals.originalLoanPaise=Number(q[0].n);totals.currentLoanSnapshotPaise=source.totals.currentLoanSnapshotPaise;
    q=await target.query("SELECT COALESCE(SUM(CASE WHEN transaction_type='opening_paid' THEN gross_paise ELSE 0 END),0)o,COALESCE(SUM(CASE WHEN transaction_type IN('payment','ots_payment') THEN gross_paise ELSE 0 END),0)p,COALESCE(SUM(CASE WHEN transaction_type='topup' THEN gross_paise ELSE 0 END),0)t,COALESCE(SUM(CASE WHEN transaction_type IN('discount','ots_adjustment') THEN gross_paise ELSE 0 END),0)a FROM financial_transactions");totals.openingPaidPaise=Number(q[0].o);totals.paymentGrossPaise=Number(q[0].p);totals.topupPaise=Number(q[0].t);totals.adjustmentPaise=Number(q[0].a);
    q=await target.query("SELECT COALESCE(SUM(CASE WHEN component='principal' AND transaction_id IN(SELECT id FROM financial_transactions WHERE transaction_type IN('payment','ots_payment')) THEN amount_paise ELSE 0 END),0)p,COALESCE(SUM(CASE WHEN component='interest' THEN amount_paise ELSE 0 END),0)i FROM transaction_allocations");totals.principalPaidPaise=Number(q[0].p);totals.interestPaidPaise=Number(q[0].i);
    q=await target.query('SELECT COALESCE(SUM(amount_paise),0)n FROM expenses');totals.expensePaise=Number(q[0].n);q=await target.query('SELECT COALESCE(SUM(amount_paise),0)n FROM non_account_transactions');totals.nonAccountPaise=Number(q[0].n);
    return {counts:counts,totals:totals};
  }

  async function foreignKeyErrors(target){var rows=await (target||adapter).query('PRAGMA foreign_key_check;');return rows||[];}

  function recoveryStageName(){return C.DATABASE_NAME+'_recovery_stage_'+Date.now()+'_'+C.uuid().replace(/-/g,'');}
  async function createFreshRecoveryAdapter(lifecycle){
    var nativePlugin=plugin()&&platform()!=='web'?plugin():null,lastError=null;
    for(var attempt=0;attempt<4;attempt++){
      var name=recoveryStageName(),candidate=nativePlugin?new NativeAdapter(nativePlugin,name,{stage:true,lifecycle:lifecycle}):new WebAdapter(true,name,{stage:true,lifecycle:lifecycle});
      try{
        await candidate.init();
        return {adapter:candidate,name:name};
      }catch(e){
        lastError=e;recoveryLog(lifecycle,'staging_create_retry',name,{retryCount:attempt+1,error:errorText(e)});
        try{await candidate.destroy();}catch(cleanupError){recoveryLog(lifecycle,'failed_stage_release_error',name,{retryCount:attempt+1,error:errorText(cleanupError)});}
      }
    }
    throw new Error('Could not create a clean recovery staging database: '+errorText(lastError));
  }

  async function validateRestoreCandidate(state,options){
    options=options||{};
    var lifecycle=[],created=await createFreshRecoveryAdapter(lifecycle),temp=created.adapter,tempName=created.name,result=null,cleanup=null;
    try{
      throwIfCancelled(options);
      var repaired=C.repairRecoveryRelationships(state,{idMappings:options.idMappings}),relationshipReport=repaired.report;
      var checked=C.validateLegacyState(repaired.state,{allowOrphanHistory:true});if(checked.critical.length)throw new Error('Recovery staging validation failed: '+checked.critical.join(' | '));
      var plan=C.buildMigrationPlan(checked.state,{allowOrphanHistory:true});if(plan.validation.critical.length)throw new Error('Recovery migration plan failed: '+plan.validation.critical.join(' | '));
      var runId=C.uuid(),now=C.nowIso(),sourceSha=await C.sha256(C.stableStringify(checked.state));
      throwIfCancelled(options);
      await temp.execute(C.SCHEMA_SQL);
      var cleared=await temp.query('SELECT COUNT(*) n FROM loans');if(cleared.length&&Number(cleared[0].n)!==0)throw new Error('Recovery staging database was not empty after reset.');
      relationshipReport.stagingDuplicateCount=0;
      relationshipReport.stagingDuplicateNumbers=[];
      relationshipReport.stagingSuggestedRepair='A brand-new uniquely named staging database was created for this scan.';
      await temp.begin();
      await temp.set([{statement:'INSERT INTO migration_runs(id,from_version,to_version,status,source_checksum,counts_json,totals_json,warnings_json,started_at) VALUES(?,?,?,?,?,?,?,?,?)',values:[runId,0,C.SCHEMA_VERSION,'staging',sourceSha,JSON.stringify(checked.counts),JSON.stringify(checked.totals),JSON.stringify(checked.warnings),now]}]);
      await setChunksOn(temp,sourceRows(checked.state,runId),250,options);await setChunksOn(temp,plan.statements,250,options);await setChunksOn(temp,entityRows(checked.state,now),250,options);
      throwIfCancelled(options);
      var staged=await dbMigrationMetrics(checked,temp),mismatches=C.compareMetrics(checked,staged),fk=await foreignKeyErrors(temp);
      var stagingDuplicates=await temp.query('SELECT loan_number,COUNT(*) n FROM loans GROUP BY business_id,loan_number HAVING COUNT(*)>1');
      relationshipReport.stagingDuplicateNumbers=stagingDuplicates.map(function(x){return {loanNumber:x.loan_number,count:Number(x.n),source:'staging'};});
      relationshipReport.stagingDuplicateCount+=stagingDuplicates.reduce(function(n,x){return n+Math.max(0,Number(x.n)-1);},0);
      if(fk.length)mismatches.push('foreign_key_check: '+fk.length+' violation(s)');
      if(mismatches.length)throw new Error('Recovery staging mismatch: '+mismatches.join(' | '));
      await temp.rollback();
      result={ok:true,checksum:sourceSha,counts:staged.counts,totals:staged.totals,warnings:checked.warnings.concat(relationshipReport.warnings||[]),foreignKeys:0,schemaVersion:C.SCHEMA_VERSION,relationshipReport:relationshipReport,repairedState:checked.state,importOrder:['borrowers','loans','loan_relationships','payment_history','collection_history'],stagingDatabaseId:tempName,stagingCleanup:'pending',stagingLifecycle:[]};
    }catch(e){try{await temp.rollback();}catch(_e){}throw e;}
    finally{
      cleanup=await temp.destroy();
      if(result){result.stagingCleanup=cleanup.status;result.stagingLifecycle=lifecycle.slice();result.stagingDeleteRetries=cleanup.retryCount;}
    }
    return result;
  }
  async function migrate(state){
    var checked=C.validateLegacyState(state);if(checked.critical.length)throw new Error('Legacy validation failed: '+checked.critical.join(' | '));
    var emergency=await emergencySnapshot(checked.state,'before-sqlite-migration'),sourceText=C.stableStringify(checked.state),sourceSha=await C.sha256(sourceText),runId=C.uuid(),plan=C.buildMigrationPlan(checked.state,{});if(plan.validation.critical.length)throw new Error(plan.validation.critical.join(' | '));
    await adapter.reset();await adapter.execute(C.SCHEMA_SQL);var now=C.nowIso(),countsJson=JSON.stringify(checked.counts),totalsJson=JSON.stringify(checked.totals);
    try{
      await adapter.begin();
      await adapter.set([{statement:'INSERT INTO migration_runs(id,from_version,to_version,status,source_checksum,counts_json,totals_json,warnings_json,started_at) VALUES(?,?,?,?,?,?,?,?,?)',values:[runId,0,C.SCHEMA_VERSION,'staging',sourceSha,countsJson,totalsJson,JSON.stringify(checked.warnings),now]}]);
      await setChunks(sourceRows(checked.state,runId));await setChunks(plan.statements);await setChunks(entityRows(checked.state,now));
      var payload=JSON.stringify(checked.state),payloadSha=await C.sha256(payload);
       var appVersion=root.VBStateBridge&&root.VBStateBridge.appVersion?root.VBStateBridge.appVersion().name:'';await adapter.set([{statement:'INSERT INTO app_state(id,payload_json,payload_checksum_sha256,counts_json,totals_json,schema_version,revision,created_at,updated_at) VALUES(1,?,?,?,?,?,1,?,?)',values:[payload,payloadSha,countsJson,totalsJson,C.SCHEMA_VERSION,now,now]},{statement:'INSERT INTO state_versions(id,revision,payload_checksum_sha256,counts_json,totals_json,reason,created_at) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),1,payloadSha,countsJson,totalsJson,'initial-migration',now]},{statement:'INSERT INTO schema_version(version,name,checksum_sha256,applied_at,app_version) VALUES(?,?,?,?,?)',values:[C.SCHEMA_VERSION,'initial-integrity-schema',await C.sha256(C.SCHEMA_SQL),now,String(appVersion)]},{statement:'INSERT INTO integrity_snapshots(id,business_id,reason,schema_version,counts_json,totals_json,relationship_errors,checksum_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',values:[C.uuid(),plan.businessId,'migration-staged',C.SCHEMA_VERSION,countsJson,totalsJson,0,payloadSha,now]}]);
      var staged=await dbMigrationMetrics(checked),mismatches=C.compareMetrics(checked,staged),fk=await foreignKeyErrors();if(fk.length)mismatches.push('foreign_key_check: '+fk.length+' violation(s)');if(mismatches.length)throw new Error('Migration mismatch: '+mismatches.join(' | '));
      await adapter.set([{statement:'UPDATE migration_runs SET status=?,staged_checksum=?,finished_at=? WHERE id=?',values:['committed',payloadSha,C.nowIso(),runId]},{statement:'INSERT INTO audit_log(id,business_id,action,entity_table,entity_id,after_checksum,reason,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)',values:[C.uuid(),plan.businessId,'MIGRATION_COMMITTED','database',runId,payloadSha,'Legacy storage migrated after exact validation',JSON.stringify({emergency:emergency,counts:checked.counts,totals:checked.totals,warnings:checked.warnings}),C.nowIso()]}]);
      await adapter.commit();await adapter.persist();
      var verify=await loadSqliteState();if(!verify||await C.sha256(JSON.stringify(verify))!==payloadSha)throw new Error('Post-commit SQLite payload verification failed.');
      localStorage.setItem(ACTIVE_KEY,JSON.stringify({database:C.DATABASE_NAME,schemaVersion:C.SCHEMA_VERSION,activatedAt:C.nowIso(),sourceSha256:sourceSha,emergencyKey:emergency.key}));
      migrationReport={runId:runId,emergency:emergency,countsBefore:checked.counts,countsAfter:staged.counts,totalsBefore:checked.totals,totalsAfter:staged.totals,warnings:checked.warnings,foreignKeys:0,checksum:payloadSha};return migrationReport;
    }catch(e){await adapter.rollback();try{await adapter.persist();}catch(_e){}localStorage.removeItem(ACTIVE_KEY);throw e;}
  }

  async function loadSqliteState(){var rows=await adapter.query('SELECT payload_json,payload_checksum_sha256,counts_json,totals_json FROM app_state WHERE id=1');if(!rows.length)return null;var text=rows[0].payload_json;if(await C.sha256(text)!==rows[0].payload_checksum_sha256)throw new Error('SQLite state checksum mismatch.');var s=C.normalizeState(JSON.parse(text)),actual={counts:C.stateCounts(s),totals:C.stateTotals(s)},stored={counts:JSON.parse(rows[0].counts_json),totals:JSON.parse(rows[0].totals_json)},mm=C.compareMetrics(stored,actual);if(mm.length)throw new Error('SQLite state validation mismatch: '+mm.join(' | '));var fk=await foreignKeyErrors();if(fk.length)throw new Error('SQLite foreign-key validation failed: '+fk.length+' violation(s).');return s;}

  function financialInsertSet(entry,legacyId,loanId,businessId,revision,source,supersedes){
    var txId=C.uuid(),gross=C.entryMoney(entry),type=C.transactionType(entry),now=C.nowIso(),set=[{statement:'INSERT INTO financial_transactions(id,business_id,loan_id,borrower_id,legacy_id,revision,transaction_type,business_date,occurred_at,gross_paise,status,source,idempotency_key,supersedes_transaction_id,raw_json,row_checksum,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',values:[txId,businessId,loanId,null,legacyId,revision,type,String(entry.date||entry.paymentDate||now.slice(0,10)),String(entry.ts||entry.createdAt||now),gross,'posted',source,'state:'+legacyId+':'+revision,supersedes||null,JSON.stringify(entry),C.financialSignature(entry),now]}];
    var principal=C.toPaise(entry.principalComponent||0),interest=C.toPaise(entry.interestComponent||0),component=C.isOpening(entry)?'opening_paid':(C.isNonCashAdjustment(entry)?'writeoff':'principal');if(C.isTopup(entry)||C.isOpening(entry)||C.isNonCashAdjustment(entry)){set.push({statement:'INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),txId,component,gross,C.toPaise(entry.balance||0),'immutable-ledger-v1',JSON.stringify(entry)]});}else{if(!principal&&!interest)principal=gross;if(principal)set.push({statement:'INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),txId,'principal',principal,C.toPaise(entry.balance||0),'immutable-ledger-v1',JSON.stringify(entry)]});if(interest)set.push({statement:'INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),txId,'interest',interest,C.toPaise(entry.balance||0),'immutable-ledger-v1',JSON.stringify(entry)]});var cash=C.toPaise(entry.cashAmt||0),upi=C.toPaise(entry.upiAmt||0);if(cash)set.push({statement:'INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',values:[C.uuid(),txId,'cash',cash,null,JSON.stringify(entry)]});if(upi)set.push({statement:'INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',values:[C.uuid(),txId,'upi',upi,String(entry.upiMethod||''),JSON.stringify(entry)]});if(!cash&&!upi&&gross>0)set.push({statement:'INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',values:[C.uuid(),txId,String(entry.pay||'').toLowerCase().indexOf('cash')>=0?'cash':'other',gross,String(entry.pay||''),JSON.stringify(entry)]});}return {id:txId,set:set};
  }

  function itemLegacyId(item,index,prefix){return String(item&&(item.id||item.loanProfileId||item.customerId||item.areaId||item.userId)||prefix+'_'+index);}
  async function syncLoanProjection(state,businessId,now){
    var existingBorrowers=await adapter.query('SELECT id,legacy_id FROM borrowers WHERE business_id=?',[businessId]),borrowerMap={};existingBorrowers.forEach(function(x){borrowerMap[String(x.legacy_id)]=x.id;});
    var customerSet=[];state.customers.forEach(function(c,i){var lid=itemLegacyId(c,i,'customer'),id=borrowerMap[lid]||C.uuid();borrowerMap[lid]=id;if(c.customerId)borrowerMap[String(c.customerId)]=id;customerSet.push({statement:'INSERT INTO borrowers(id,business_id,legacy_id,customer_number,full_name,kyc_number,normalized_match_key,raw_json,created_at,updated_at,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL) ON CONFLICT(business_id,legacy_id) DO UPDATE SET customer_number=excluded.customer_number,full_name=excluded.full_name,kyc_number=excluded.kyc_number,normalized_match_key=excluded.normalized_match_key,raw_json=excluded.raw_json,updated_at=excluded.updated_at,version=borrowers.version+1,deleted_at=NULL',values:[id,businessId,lid,String(c.custNo||'')||null,String(c.name||'Unknown'),String(c.kycNo||'')||null,String(c.matchKey||'')||null,JSON.stringify(c),String(c.createdAt||now),now]});});await setChunks(customerSet);
    var areaRows=await adapter.query('SELECT id,legacy_id,name FROM areas WHERE business_id=?',[businessId]),areaMap={};areaRows.forEach(function(x){areaMap[String(x.legacy_id)]=x.id;areaMap[String(x.name||'').toLowerCase()]=x.id;});
    var existingLoans=await adapter.query('SELECT id,legacy_id,status,original_loan_amount_paise,original_start_date,borrower_id FROM loans WHERE business_id=?',[businessId]),loanMap={};existingLoans.forEach(function(x){loanMap[String(x.legacy_id)]=x;});
    var seen={},set=[];
    for(var i=0;i<state.borrowers.length;i++){
      var loan=state.borrowers[i],lid=itemLegacyId(loan,i,'loan'),row=loanMap[lid],original=C.originalPrincipalPaise(loan),start=C.originalStartDate(loan)||'1970-01-01',customerLegacy=String(loan.customerId||loan.custId||''),borrowerId=borrowerMap[customerLegacy];seen[lid]=1;
      if(row&&(Number(row.original_loan_amount_paise)!==original||String(row.original_start_date)!==String(start)))throw new Error('Immutable loan origin mismatch for '+lid+'. Save rolled back.');
      if(!borrowerId&&row)borrowerId=row.borrower_id;
      if(!borrowerId){var synthetic='loan-borrower:'+lid;borrowerId=borrowerMap[synthetic]||C.uuid();borrowerMap[synthetic]=borrowerId;set.push({statement:'INSERT INTO borrowers(id,business_id,legacy_id,customer_number,full_name,raw_json,created_at,updated_at,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,1,NULL) ON CONFLICT(business_id,legacy_id) DO UPDATE SET full_name=excluded.full_name,raw_json=excluded.raw_json,updated_at=excluded.updated_at,version=borrowers.version+1,deleted_at=NULL',values:[borrowerId,businessId,synthetic,String(loan.custNo||'')||null,String(loan.name||'Unknown'),JSON.stringify({migratedFromLoan:lid,name:loan.name,phone:loan.phone,area:loan.area}),String(loan.createdAt||now),now]});}
      var areaId=areaMap[String(loan.areaId||'')]||areaMap[String(loan.area||'').toLowerCase()]||null;
      if(row){var nextStatus=C.currentLoanStatus(loan);set.push({statement:'UPDATE loans SET borrower_id=?,status=?,contractual_end_date=?,current_area_id=?,raw_json=?,updated_at=?,version=version+1,deleted_at=NULL WHERE id=?',values:[borrowerId,nextStatus,String(loan.loanend||loan.loanEnd||'')||null,areaId,JSON.stringify(loan),now,row.id]});if(String(row.status)!==nextStatus)set.push({statement:'INSERT INTO loan_events(id,loan_id,event_type,event_date,occurred_at,from_status,to_status,reason,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',values:[C.uuid(),row.id,nextStatus==='active'?'reopened':(nextStatus==='temporarily_closed'?'next_week':'closed'),String(loan.completedDate||loan.nextEligibleDate||loan.reopenDate||now.slice(0,10)),now,String(row.status),nextStatus,'Atomic status transition',JSON.stringify({legacyId:lid})]});}
      else{var loanId=C.uuid();set.push({statement:'INSERT INTO loans(id,business_id,borrower_id,legacy_id,loan_number,product_type,status,original_loan_amount_paise,original_start_date,contractual_end_date,opening_paid_paise,opening_paid_date,current_area_id,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',values:[loanId,businessId,borrowerId,lid,String(loan.recoveryStagingLoanNumber||loan.loanno||loan.loanNumber||('LEGACY-'+lid)),C.productType(loan),C.currentLoanStatus(loan),original,start,String(loan.loanend||loan.loanEnd||'')||null,C.toPaise(loan.originalOpeningPaid!==undefined?loan.originalOpeningPaid:(loan.openingPaidAmount||loan.openingPrev||0)),String(loan.openingPaidDate||'')||null,areaId,JSON.stringify(loan),String(loan.createdAt||now),now]});set.push({statement:'INSERT INTO loan_events(id,loan_id,event_type,event_date,occurred_at,to_status,reason,raw_json) VALUES(?,?,?,?,?,?,?,?)',values:[C.uuid(),loanId,'created',start,now,'active','Atomic SQLite create',JSON.stringify({legacyId:lid})]});}
    }
    await setChunks(set);var removed=existingLoans.filter(function(x){return !seen[String(x.legacy_id)];});for(var r=0;r<removed.length;r++)await adapter.set([{statement:'UPDATE loans SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL',values:[now,now,removed[r].id]},{statement:'INSERT OR IGNORE INTO tombstones(id,business_id,entity_table,entity_id,deleted_at,reason,row_version) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),businessId,'loans',removed[r].id,now,'Removed from active application state',1]}]);
    return state.borrowers.reduce(function(sum,x){return sum+C.originalPrincipalPaise(x);},0);
  }

  async function syncOperationalTransactionProjection(state,businessId,now){
    var specs=[
      {stateKey:'expenses',table:'expenses',entity:'expenses',prefix:'expense',type:function(row){return String(row.category||'Other');},amount:function(row){return C.toPaise(row.amount||0,'expense.amount');}},
      {stateKey:'nonAccTxns',table:'non_account_transactions',entity:'non_account_transactions',prefix:'non_account',type:function(row){return String(row.type||'cash_out');},amount:function(row){return C.toPaise(row.amount||0,'nonAccount.amount');}}
    ];
    for(var s=0;s<specs.length;s++){
      var spec=specs[s],existing=await adapter.query('SELECT id,legacy_id FROM '+spec.table+' WHERE business_id=? AND deleted_at IS NULL',[businessId]),byLegacy={},seen={},set=[];
      existing.forEach(function(row){byLegacy[String(row.legacy_id)]=row;});
      (state[spec.stateKey]||[]).forEach(function(row,index){
        var legacyId=itemLegacyId(row,index,spec.prefix),existingRow=byLegacy[legacyId],id=existingRow?existingRow.id:C.uuid(),raw=JSON.stringify(row||{}),date=String(row.date||row.businessDate||now.slice(0,10)),amount=spec.amount(row||{}),mode=String(row.mode||row.pay||'Cash'),area=String(row.areaId||row.area||'')||null;
        seen[legacyId]=1;
        if(spec.table==='expenses')set.push({statement:'INSERT INTO expenses(id,business_id,legacy_id,business_date,amount_paise,payment_mode,category,area_legacy_id,raw_json,created_at,updated_at,deleted_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,1) ON CONFLICT(business_id,legacy_id) DO UPDATE SET business_date=excluded.business_date,amount_paise=excluded.amount_paise,payment_mode=excluded.payment_mode,category=excluded.category,area_legacy_id=excluded.area_legacy_id,raw_json=excluded.raw_json,updated_at=excluded.updated_at,deleted_at=NULL,version=expenses.version+1',values:[id,businessId,legacyId,date,amount,mode,spec.type(row||{}),area,raw,String(row.createdAt||now),now]});
        else set.push({statement:'INSERT INTO non_account_transactions(id,business_id,legacy_id,business_date,transaction_type,amount_paise,payment_mode,area_legacy_id,raw_json,created_at,updated_at,deleted_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,1) ON CONFLICT(business_id,legacy_id) DO UPDATE SET business_date=excluded.business_date,transaction_type=excluded.transaction_type,amount_paise=excluded.amount_paise,payment_mode=excluded.payment_mode,area_legacy_id=excluded.area_legacy_id,raw_json=excluded.raw_json,updated_at=excluded.updated_at,deleted_at=NULL,version=non_account_transactions.version+1',values:[id,businessId,legacyId,date,spec.type(row||{}),amount,mode,area,raw,String(row.createdAt||now),now]});
      });
      await setChunks(set);
      var removed=existing.filter(function(row){return !seen[String(row.legacy_id)];});
      for(var r=0;r<removed.length;r++)await adapter.set([
        {statement:'UPDATE '+spec.table+' SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL',values:[now,now,removed[r].id]},
        {statement:'INSERT OR IGNORE INTO tombstones(id,business_id,entity_table,entity_id,deleted_at,reason,row_version) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),businessId,spec.entity,removed[r].id,now,'Removed from active application state',1]}
      ]);
    }
  }

  async function currentLedgerMetrics(){
    var q=await adapter.query("SELECT COUNT(*) history,COALESCE(SUM(CASE WHEN transaction_type='opening_paid' THEN gross_paise ELSE 0 END),0) openingPaidPaise,COALESCE(SUM(CASE WHEN transaction_type IN('payment','ots_payment') THEN gross_paise ELSE 0 END),0) paymentGrossPaise,COALESCE(SUM(CASE WHEN transaction_type='topup' THEN gross_paise ELSE 0 END),0) topupPaise,COALESCE(SUM(CASE WHEN transaction_type IN('discount','ots_adjustment') THEN gross_paise ELSE 0 END),0) adjustmentPaise FROM v_current_financial_transactions");var a=await adapter.query("SELECT COALESCE(SUM(CASE WHEN a.component='principal' AND t.transaction_type IN('payment','ots_payment') THEN a.amount_paise ELSE 0 END),0) principalPaidPaise,COALESCE(SUM(CASE WHEN a.component='interest' THEN a.amount_paise ELSE 0 END),0) interestPaidPaise FROM transaction_allocations a JOIN v_current_financial_transactions t ON t.id=a.transaction_id");return Object.assign({},q[0],a[0]);
  }
  async function currentOperationalTransactionMetrics(){
    var expenses=await adapter.query('SELECT COUNT(*) count,COALESCE(SUM(amount_paise),0) total FROM expenses WHERE deleted_at IS NULL'),nonAccount=await adapter.query('SELECT COUNT(*) count,COALESCE(SUM(amount_paise),0) total FROM non_account_transactions WHERE deleted_at IS NULL');
    return {expenses:Number(expenses[0].count||0),expensePaise:Number(expenses[0].total||0),nonAccount:Number(nonAccount[0].count||0),nonAccountPaise:Number(nonAccount[0].total||0)};
  }

  async function persistState(state,reason){
    var checked=C.validateLegacyState(state);if(checked.critical.length)throw new Error('Save rejected: '+checked.critical.join(' | '));var current=await adapter.query('SELECT revision FROM app_state WHERE id=1'),revision=current.length?Number(current[0].revision)+1:1,now=C.nowIso(),payload=JSON.stringify(checked.state),sha=await C.sha256(payload),business=(await adapter.query('SELECT id FROM businesses LIMIT 1'))[0],businessId=business.id;
    var loans=await adapter.query('SELECT id,legacy_id FROM loans'),loanMap={};loans.forEach(function(x){loanMap[String(x.legacy_id)]=x.id;});var latest=await adapter.query('SELECT t.id,t.legacy_id,t.revision,t.row_checksum,t.status FROM financial_transactions t JOIN(SELECT legacy_id,MAX(revision)r FROM financial_transactions GROUP BY legacy_id)x ON x.legacy_id=t.legacy_id AND x.r=t.revision'),latestMap={};latest.forEach(function(x){latestMap[String(x.legacy_id)]=x;});
    try{await adapter.begin();await setChunks(entityRows(checked.state,now));await syncLoanProjection(checked.state,businessId,now);await syncOperationalTransactionProjection(checked.state,businessId,now);var seen={};
      for(var i=0;i<checked.state.entryLog.length;i++){var e=checked.state.entryLog[i],lid=String(e.id||'entry_'+i),old=latestMap[lid],sig=C.financialSignature(e);seen[lid]=1;if(!old){await setChunks(financialInsertSet(e,lid,loanMap[String(e.bid||e.loanId||e.loanProfileId||e.borrowerId)]||null,businessId,1,'ui',null).set);}else if(old.status!=='posted'||old.row_checksum!==sig){var rev=Number(old.revision)+1,reversalId=C.uuid();await adapter.set([{statement:'INSERT INTO financial_transactions(id,business_id,loan_id,borrower_id,legacy_id,revision,transaction_type,business_date,occurred_at,gross_paise,status,source,idempotency_key,reverses_transaction_id,raw_json,row_checksum,created_at) SELECT ?,business_id,loan_id,borrower_id,legacy_id,? ,\'reversal\',?,?,-gross_paise,\'reversed\',\'ui\',?,id,raw_json,?,? FROM financial_transactions WHERE id=?',values:[reversalId,rev,String(e.date||now.slice(0,10)),now,'reversal:'+lid+':'+rev,C.financialSignature(e),now,old.id]}]);await setChunks(financialInsertSet(e,lid,loanMap[String(e.bid||e.loanId||e.loanProfileId||e.borrowerId)]||null,businessId,rev+1,'ui',old.id).set);}}
      var missing=Object.keys(latestMap).filter(function(k){return latestMap[k].status==='posted'&&!seen[k];});for(var m=0;m<missing.length;m++){var old=latestMap[missing[m]],rev=Number(old.revision)+1;await adapter.set([{statement:'INSERT INTO financial_transactions(id,business_id,loan_id,borrower_id,legacy_id,revision,transaction_type,business_date,occurred_at,gross_paise,status,source,idempotency_key,reverses_transaction_id,raw_json,row_checksum,created_at,deleted_at) SELECT ?,business_id,loan_id,borrower_id,legacy_id,?,\'reversal\',?,?, -gross_paise,\'tombstone\',\'ui\',?,id,raw_json,?,?,? FROM financial_transactions WHERE id=?',values:[C.uuid(),rev,now.slice(0,10),now,'tombstone:'+missing[m]+':'+rev,C.fastHash('deleted:'+missing[m]+':'+rev),now,now,old.id]}]);}
      var live=await currentLedgerMetrics(),operational=await currentOperationalTransactionMetrics(),ledgerMismatch=[];['history','openingPaidPaise','paymentGrossPaise','principalPaidPaise','interestPaidPaise','topupPaise','adjustmentPaise'].forEach(function(k){var expected=k==='history'?checked.counts.history:checked.totals[k];if(Number(live[k])!==Number(expected))ledgerMismatch.push(k+': '+expected+' != '+live[k]);});['expenses','nonAccount'].forEach(function(k){if(Number(operational[k])!==Number(checked.counts[k]))ledgerMismatch.push(k+': '+checked.counts[k]+' != '+operational[k]);});['expensePaise','nonAccountPaise'].forEach(function(k){if(Number(operational[k])!==Number(checked.totals[k]))ledgerMismatch.push(k+': '+checked.totals[k]+' != '+operational[k]);});var loanTotal=await adapter.query('SELECT COALESCE(SUM(original_loan_amount_paise),0)n FROM loans WHERE deleted_at IS NULL');if(Number(loanTotal[0].n)!==Number(checked.totals.originalLoanPaise))ledgerMismatch.push('originalLoanPaise: '+checked.totals.originalLoanPaise+' != '+loanTotal[0].n);if(ledgerMismatch.length)throw new Error('Financial integrity mismatch before commit: '+ledgerMismatch.join(' | '));
      var countsJson=JSON.stringify(checked.counts),totalsJson=JSON.stringify(checked.totals);await adapter.set([{statement:'UPDATE app_state SET payload_json=?,payload_checksum_sha256=?,counts_json=?,totals_json=?,schema_version=?,revision=?,updated_at=? WHERE id=1',values:[payload,sha,countsJson,totalsJson,C.SCHEMA_VERSION,revision,now]},{statement:'INSERT INTO state_versions(id,revision,payload_checksum_sha256,counts_json,totals_json,reason,created_at) VALUES(?,?,?,?,?,?,?)',values:[C.uuid(),revision,sha,countsJson,totalsJson,String(reason||'save'),now]},{statement:'INSERT INTO integrity_snapshots(id,business_id,reason,schema_version,counts_json,totals_json,relationship_errors,checksum_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',values:[C.uuid(),businessId,String(reason||'save'),C.SCHEMA_VERSION,countsJson,totalsJson,0,sha,now]},{statement:'INSERT INTO audit_log(id,business_id,action,entity_table,after_checksum,reason,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)',values:[C.uuid(),businessId,'STATE_COMMITTED','app_state',sha,String(reason||'save'),JSON.stringify({revision:revision,counts:checked.counts,totals:checked.totals}),now]}]);await adapter.commit();await adapter.persist();var rows=await adapter.query('SELECT payload_checksum_sha256 FROM app_state WHERE id=1');if(!rows.length||rows[0].payload_checksum_sha256!==sha)throw new Error('Post-save checksum verification failed.');return {revision:revision,checksum:sha,counts:checked.counts,totals:checked.totals};
    }catch(e){await adapter.rollback();throw e;}
  }

  function queuePersist(reason){if(!active||writeSuspend>0)return Promise.resolve(null);pendingReason=pendingReason?pendingReason+'+'+String(reason||'save'):String(reason||'save');var snapshot=captureState();persistChain=persistChain.catch(function(){return null;}).then(function(){var r=pendingReason;pendingReason='';return persistState(snapshot,r);}).then(function(result){lastPersistError=null;return result;},async function(e){lastPersistError=e;console.error('[VBSQLite] atomic save failed',e);try{localStorage.setItem('vb_sqlite_last_error',JSON.stringify({at:C.nowIso(),message:e.message}));}catch(_e){}try{var safe=await loadSqliteState();if(safe)applyState(safe);}catch(reloadError){console.error('[VBSQLite] could not reload last committed state',reloadError);}if(root.showToast)root.showToast('Data save failed safely. Previous SQLite state was restored. '+e.message,'err',7000);return null;});return persistChain;}
  function flush(){return persistChain.then(function(result){if(lastPersistError){var error=lastPersistError;lastPersistError=null;throw error;}return result;});}
  async function beginAtomicRestore(){if(!active)return null;await flush();writeSuspend++;return {before:captureState(),startedAt:C.nowIso()};}
  async function commitAtomicRestore(stage,reason){if(!active||!stage)return null;var candidate=captureState();try{var result=await persistState(candidate,'restore:'+String(reason||'import'));lastPersistError=null;return result;}finally{writeSuspend=Math.max(0,writeSuspend-1);}}
  function cancelAtomicRestore(stage){if(active&&stage)writeSuspend=Math.max(0,writeSuspend-1);}

  function installWriteThrough(){
    if(installWriteThrough.done)return;installWriteThrough.done=true;
    var oldSave=root.saveState,oldFast=root.saveStateFast;root.saveState=function(){return queuePersist('saveState');};root.saveStateFast=function(){return queuePersist('saveStateFast');};root._vbLegacySaveState=oldSave;root._vbLegacySaveStateFast=oldFast;
    ['saveReminders','saveCashBookExpenses','_mumSaveUsers','_mumSaveAudit','_mumSaveSession','saveCfg','saveSettings'].forEach(function(name){var fn=root[name];if(typeof fn!=='function')return;root[name]=function(){var value=fn.apply(this,arguments);queuePersist(name);return value;};});
    ['exportData','backupToDrive','_gdIncrementalBackupImpl','_legacyBackupToDriveImpl'].forEach(function(name){var fn=root[name];if(typeof fn!=='function'||fn._vbSqliteWrapped)return;var wrapped=async function(){await flush();return fn.apply(this,arguments);};wrapped._vbSqliteWrapped=true;root[name]=wrapped;});
  }

  function runOriginalWithState(original,event,state){
    var names=['loadState','loadSettings','loadReminders','loadCashBook'],saved={};names.forEach(function(n){saved[n]=root[n];root[n]=function(){applyState(state);};});try{return original&&original.call(root,event);}finally{names.forEach(function(n){root[n]=saved[n];});}
  }

  async function boot(original,event){
    var originalRan=false;showBlock('Opening the protected local database...');
    try{await createAdapter();var marker=localStorage.getItem(ACTIVE_KEY),sqliteState=null;if(marker)sqliteState=await loadSqliteState();
      if(sqliteState){active=true;runOriginalWithState(original,event,sqliteState);originalRan=true;applyState(sqliteState);installWriteThrough();ready=true;hideBlock();return;}
      showBlock('Creating and verifying an emergency snapshot. Existing storage will remain untouched.');if(original){original.call(root,event);originalRan=true;}await new Promise(function(resolve){setTimeout(resolve,500);});var legacy=captureState();showBlock('Migrating records into a separate SQLite database and validating every count and total...');await migrate(legacy);var migratedState=await loadSqliteState();applyState(migratedState);active=true;installWriteThrough();ready=true;hideBlock();if(root.showToast)root.showToast('SQLite migration verified. Existing storage retained as recovery copy.','ok',5000);
    }catch(e){active=false;ready=true;localStorage.removeItem(ACTIVE_KEY);hideBlock();console.error('[VBSQLite] activation stopped safely',e);try{localStorage.setItem('vb_sqlite_last_error',JSON.stringify({at:C.nowIso(),message:e.message}));}catch(_e){}if(root.showToast)root.showToast('SQLite migration stopped safely: '+e.message+'. Existing data remains unchanged.','err',9000);if(!originalRan){try{original&&original.call(root,event);}catch(_e){}}}
  }

  var originalOnload=root.onload;root.onload=function(e){boot(originalOnload,e);};
  root.VBSqliteIntegrity={isActive:function(){return active;},isReady:function(){return ready;},flush:flush,captureState:captureState,loadState:loadSqliteState,persistNow:function(reason){return queuePersist(reason||'manual');},beginAtomicRestore:beginAtomicRestore,commitAtomicRestore:commitAtomicRestore,cancelAtomicRestore:cancelAtomicRestore,validateRestoreCandidate:validateRestoreCandidate,getRecoveryLifecycleLog:function(){return recoveryLifecycleLog.slice();},getMigrationReport:function(){return migrationReport;},getLastError:function(){return localJson('vb_sqlite_last_error',null);},adapter:function(){return adapter;},emergencySnapshot:function(reason){return emergencySnapshot(captureState(),reason||'manual');}};
})(window);
