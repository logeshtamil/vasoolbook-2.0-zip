(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.VBSqliteCore=api;
})(typeof self!=='undefined'?self:this,function(){
  'use strict';

  var SCHEMA_VERSION=1;
  var DATABASE_NAME='vasoolbook_integrity_v1';
  var MAX_SAFE_PAISE=Number.MAX_SAFE_INTEGER;

  function nowIso(){return new Date().toISOString();}
  function clone(v){return JSON.parse(JSON.stringify(v===undefined?null:v));}
  function arr(v){return Array.isArray(v)?v:[];}
  function obj(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
  function str(v){return v===undefined||v===null?'':String(v);}
  function bool(v){return v===true||v===1||v==='1';}

  function uuid(){
    if(typeof crypto!=='undefined'&&crypto.randomUUID)return crypto.randomUUID();
    var t=Date.now().toString(16),r='';
    for(var i=0;i<24;i++)r+=Math.floor(Math.random()*16).toString(16);
    return (t+r).slice(0,8)+'-'+r.slice(0,4)+'-4'+r.slice(5,8)+'-a'+r.slice(9,12)+'-'+r.slice(12,24);
  }

  function stableStringify(value){
    if(value===null||typeof value!=='object')return JSON.stringify(value);
    if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';
    return '{'+Object.keys(value).sort().map(function(k){return JSON.stringify(k)+':'+stableStringify(value[k]);}).join(',')+'}';
  }

  function fastHash(text){
    text=str(text);var h1=0x811c9dc5,h2=0x9e3779b9;
    for(var i=0;i<text.length;i++){
      var c=text.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2+c,2246822519);
    }
    return ((h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0'));
  }

  async function sha256(text){
    text=str(text);
    if(typeof crypto!=='undefined'&&crypto.subtle&&typeof TextEncoder!=='undefined'){
      var d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
      return Array.from(new Uint8Array(d)).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
    }
    if(typeof require==='function')return require('crypto').createHash('sha256').update(text,'utf8').digest('hex');
    return fastHash(text).repeat(4);
  }

  function toPaise(value,field){
    if(value===undefined||value===null||value==='')return 0;
    var s=String(value).trim().replace(/[,\s\u20b9]/g,'');
    if(!/^[+-]?\d+(?:\.\d+)?$/.test(s))throw new Error('Invalid money value for '+(field||'amount')+': '+String(value));
    var neg=s.charAt(0)==='-';if(neg||s.charAt(0)==='+')s=s.slice(1);
    var p=s.split('.'),whole=BigInt(p[0]||'0'),frac=(p[1]||'');
    var cents=BigInt((frac+'00').slice(0,2));
    if(frac.length>2&&Number(frac.charAt(2))>=5)cents+=1n;
    if(cents>=100n){whole+=1n;cents-=100n;}
    var out=whole*100n+cents;if(neg)out=-out;
    if(out>BigInt(MAX_SAFE_PAISE)||out<BigInt(-MAX_SAFE_PAISE))throw new Error('Money overflow for '+(field||'amount'));
    return Number(out);
  }

  function fromPaise(value){return Number(value||0)/100;}

  function legacyId(item,index,prefix){
    var id=item&&(item.id||item.loanProfileId||item.customerId||item.areaId||item.userId);
    return str(id||((prefix||'legacy')+'_'+index));
  }

  function originalPrincipalPaise(loan){
    var explicit=loan.originalLoanAmount;
    if(explicit===undefined||explicit===null||explicit==='')explicit=loan.baseLoanAmount;
    if(explicit===undefined||explicit===null||explicit==='')explicit=loan.originalPrincipal;
    if(explicit===undefined||explicit===null||explicit===''){
      var top=arr(loan.topups).reduce(function(s,t){return s+toPaise(t.amount||0,'topup.amount');},0);
      return Math.max(0,toPaise(loan.loan||loan.principalAmt||0,'loan.loan')-top);
    }
    return Math.max(0,toPaise(explicit,'loan.originalLoanAmount'));
  }

  function originalStartDate(loan){
    return str(loan.originalLoanDate||loan.loanStartDate||loan.loandate||(loan.createdAt?str(loan.createdAt).slice(0,10):''));
  }

  function isOpening(entry){
    return !!(entry&&(entry.isOpeningBalance||entry.isOpeningPaid||entry.paymentPurpose==='opening_paid'||entry.entryType==='opening_paid'||entry.pay==='Opening Balance'||entry.note==='Carried forward'));
  }
  function isTopup(entry){return !!(entry&&(entry.isTopUp||entry.paymentPurpose==='topup'||entry.pay==='Top-Up'||Number(entry.topupAmount||0)>0));}
  function isNeutral(entry){return !!(entry&&(entry.balanceNeutral||entry.isNpaMove||entry.paymentPurpose==='npa_move'||entry.isReopened||entry.pay==='Loan Reopened'||isTopup(entry)));}
  function isNonCashAdjustment(entry){return !!(entry&&(entry.isOTSBalAdj||entry.paymentPurpose==='ots_bal_adjustment'||entry.isDiscountClosure||entry.paymentPurpose==='discount_closure'));}

  function transactionType(entry){
    var p=str(entry&&entry.paymentPurpose).toLowerCase();
    if(isOpening(entry))return 'opening_paid';
    if(isTopup(entry))return 'topup';
    if(entry&&entry.isOTSPayment)return 'ots_payment';
    if(entry&&entry.isOTSBalAdj)return 'ots_adjustment';
    if(entry&&entry.isDiscountClosure)return 'discount';
    if(entry&&entry.isNpaMove)return 'migration_adjustment';
    if(entry&&entry.isReopened)return 'migration_adjustment';
    if(p==='loan_closure'||entry&&entry.isLoanClosure)return 'payment';
    return 'payment';
  }

  function financialSignature(entry){
    entry=entry||{};
    var fields=['id','bid','borrowerId','loanId','loanProfileId','customerId','date','paymentDate','paidDate','today','paidAmount','amount','principalComponent','interestComponent','cashAmt','upiAmt','upiMethod','pay','bank','isSplit','paymentPurpose','entryType','isOpeningBalance','isOpeningPaid','openingPaidAmount','isTopUp','topupId','topupAmount','topupInterest','isLoanClosure','isFullClose','isFullPaid','isPaidOff','isDiscountClosure','interestReduceAmt','finalClosureAmt','isOTS','isOTSPayment','isOTSBalAdj','otsPaidToday','otsAdjustedBalance','otsBalanceWrittenOff','isNpaMove','isReopened','reopenedDate','restoredBalance','cyclePeriodStart','cyclePeriodEnd','preClosureDate','preClosureDue','totalDueAtPayment'];
    var out={};fields.forEach(function(k){if(entry[k]!==undefined)out[k]=entry[k];});
    return fastHash(stableStringify(out));
  }

  // Privacy-safe integrity projections: only the returned hashes/counts leave
  // this module. The selected fields cover financial amounts, links, cycle
  // allocations and timestamps without logging the underlying customer data.
  function integrityPick(value,fields){
    value=obj(value);var out={};fields.forEach(function(k){if(value[k]!==undefined)out[k]=value[k];});return out;
  }
  function financialRecordFingerprint(kind,value,index){
    var common=['id','loanId','loanProfileId','bid','borrowerId','customerId','createdAt','updatedAt','ts','date','paymentDate','paidDate','revision','rowVersion','version','deletedAt'];
    var fields=common.slice();
    if(kind==='borrowers'||kind==='loans')fields=fields.concat(['name','phone','area','areaId','mainArea','mainAreaId','subArea','subAreaId','loan','principalAmt','remainingPrincipal','balance','currentLoanAmount','originalLoanAmount','originalLoanDate','loanDate','loandate','interestCalcStart','calcStartDate','previousPending','prevPendingInterest','pendingInterest','interestCredit','loanType','type','interest','interestRate','rate','weeks','months','instalment','installment','openingPaid','openingPaidAmount','openingPaidDate','status','closed','isClosed','isPaidOff','discount','interestDiscount','topups','interestCycles','cycleAllocations','interestAllocations','advanceInterestAllocations']);
    else if(kind==='entryLog'||kind==='payments'||kind==='history')fields=fields.concat(['today','paidAmount','amount','loanAmt','principalComponent','interestComponent','cashAmt','upiAmt','bankAmt','cash','upi','bank','upiMethod','pay','isSplit','paymentPurpose','entryType','isOpeningBalance','isOpeningPaid','openingPaidAmount','isTopUp','topupId','topupAmount','topupInterest','isLoanClosure','isFullClose','isFullPaid','isPaidOff','isOTS','isOTSPayment','isOTSBalAdj','otsPaidToday','otsAdjustedBalance','interestReduceAmt','interestDiscount','discountAmount','interestBalanceChoice','cycleId','cyclePeriodStart','cyclePeriodEnd','cycleAllocations','interestAllocations','advanceAllocations','interestPaidThroughDate','balance','remainingPrincipal']);
    else if(kind==='areas')fields=fields.concat(['name','areaName','areaId','mainAreaId','parentAreaId','areaType','collectionDay','collectionDays','day','days']);
    else if(kind==='customers')fields=fields.concat(['name','firstName','lastName','phone','mobile','area','areaId','mainAreaId','subAreaId']);
    else if(kind==='nonAccTxns'||kind==='expenses')fields=fields.concat(['amount','cashAmt','upiAmt','bankAmt','pay','bank','category','type']);
    else fields=Object.keys(obj(value));
    return fastHash(stableStringify({kind:kind||'generic',index:index||0,fields:integrityPick(value,fields)}));
  }
  function financialIntegritySnapshot(input){
    var state=normalizeState(input),groups={customers:state.customers,borrowers:state.borrowers,entryLog:state.entryLog,areas:state.areas,nonAccTxns:state.nonAccTxns,expenses:state.expenses,upiIds:state.upiIds,tombstones:state.tombstones},categories={},records={};
    Object.keys(groups).forEach(function(kind){var rows=arr(groups[kind]).map(function(row,index){return {id:legacyId(row,index,kind),hash:financialRecordFingerprint(kind,row,index)};}).sort(function(a,b){return a.id<b.id?-1:a.id>b.id?1:(a.hash<b.hash?-1:a.hash>b.hash?1:0);});categories[kind]={count:rows.length,hash:fastHash(stableStringify(rows))};
      // id->hash breakdown, kept alongside the rolled-up category hash purely
      // for diagnostics: on a mismatch this lets compareFinancialIntegrity name
      // the exact differing record IDs instead of only the category hash.
      // Still privacy-safe — only IDs and hashes leave this module, never field values.
      var byId={};rows.forEach(function(r){byId[r.id]=r.hash;});records[kind]=byId;
    });
    return {version:1,categories:categories,records:records,hash:fastHash(stableStringify(categories))};
  }
  function compareFinancialIntegrity(expected,actual){
    var mismatches=[];if(!expected||!expected.categories||!actual||!actual.categories)return ['financial integrity snapshot unavailable'];
    Object.keys(expected.categories).forEach(function(kind){
      var a=actual.categories[kind]||{},e=expected.categories[kind]||{};
      if(Number(e.count)!==Number(a.count))mismatches.push('content.'+kind+'.count mismatch ('+Number(e.count||0)+' -> '+Number(a.count||0)+')');
      if(String(e.hash)!==String(a.hash)){
        var detail='content.'+kind+'.hash mismatch',eIds=expected.records&&expected.records[kind],aIds=actual.records&&actual.records[kind];
        if(eIds&&aIds){
          var missing=[],added=[],changed=[];
          Object.keys(eIds).forEach(function(id){
            if(!Object.prototype.hasOwnProperty.call(aIds,id))missing.push(id);
            else if(String(aIds[id])!==String(eIds[id]))changed.push(id);
          });
          Object.keys(aIds).forEach(function(id){if(!Object.prototype.hasOwnProperty.call(eIds,id))added.push(id);});
          if(missing.length||added.length||changed.length){
            detail+=': changedIDs=['+changed.slice(0,10).join(',')+']'
              +(missing.length?', missingIDs=['+missing.slice(0,10).join(',')+']':'')
              +(added.length?', addedIDs=['+added.slice(0,10).join(',')+']':'');
          }
        }else detail+=' (record-level ID breakdown unavailable for this legacy backup)';
        mismatches.push(detail);
      }
    });
    return mismatches;
  }

  function entryMoney(entry){
    if(isTopup(entry))return toPaise(entry.topupAmount||entry.loanAmt||0,'entry.topupAmount');
    return toPaise(entry.today!==undefined?entry.today:(entry.paidAmount!==undefined?entry.paidAmount:entry.amount||0),'entry.today');
  }

  function stateCounts(state){
    state=obj(state);
    return {
      customers:arr(state.customers).length,
      loans:arr(state.borrowers).length,
      history:arr(state.entryLog).length,
      areas:arr(state.areas).length,
      nonAccount:arr(state.nonAccTxns).length,
      upi:arr(state.upiIds).length,
      expenses:arr(state.expenses).length,
      reminders:arr(state.reminders).length,
      reports:arr(state.collReports).length,
      users:arr(state.users).length,
      audit:arr(state.auditLog).length
    };
  }

  // A single corrupted money field anywhere in a large state must not abort
  // this whole aggregate computation (stateTotals feeds validation/restore
  // comparison paths) — a bad record contributes 0 and is surfaced elsewhere
  // (e.g. validateLegacyState's per-record check) as an explicit critical
  // error instead of an uncaught exception.
  function safeMoney(fn){try{var v=fn();return typeof v==='number'&&isFinite(v)?v:0;}catch(e){return 0;}}
  function stateTotals(state){
    state=obj(state);var loans=arr(state.borrowers),entries=arr(state.entryLog);
    var original=loans.reduce(function(s,b){return s+safeMoney(function(){return originalPrincipalPaise(b);});},0);
    var currentLoan=loans.reduce(function(s,b){return s+safeMoney(function(){return toPaise(b.loan||b.principalAmt||0,'loan.current');});},0);
    var opening=0,payments=0,principal=0,interest=0,topups=0,adjustments=0;
    entries.forEach(function(e){
      var amount=safeMoney(function(){return entryMoney(e);});
      if(isOpening(e)){opening+=amount;return;}
      if(isTopup(e)){topups+=amount;return;}
      if(isNonCashAdjustment(e)){adjustments+=amount;return;}
      if(isNeutral(e))return;
      payments+=amount;
      principal+=safeMoney(function(){return toPaise(e.principalComponent||(!e.interestComponent?fromPaise(amount):0),'entry.principalComponent');});
      interest+=safeMoney(function(){return toPaise(e.interestComponent||0,'entry.interestComponent');});
    });
    var expenses=arr(state.expenses).reduce(function(s,e){return s+safeMoney(function(){return toPaise(e.amount||0,'expense.amount');});},0);
    var nonAccount=arr(state.nonAccTxns).reduce(function(s,e){return s+safeMoney(function(){return toPaise(e.amount||0,'nonAcc.amount');});},0);
    return {originalLoanPaise:original,currentLoanSnapshotPaise:currentLoan,openingPaidPaise:opening,paymentGrossPaise:payments,principalPaidPaise:principal,interestPaidPaise:interest,topupPaise:topups,adjustmentPaise:adjustments,expensePaise:expenses,nonAccountPaise:nonAccount};
  }

  function normalizeState(input){
    var s=obj(clone(input));
    ['customers','borrowers','entryLog','areas','nonAccTxns','upiIds','expenses','reminders','collReports','users','auditLog','tombstones'].forEach(function(k){s[k]=arr(s[k]);});
    s.borrowers=s.borrowers.map(function(loan){
      loan=obj(loan);
      if(loan.originalLoanAmount===undefined||loan.originalLoanAmount===null||loan.originalLoanAmount==='')loan.originalLoanAmount=fromPaise(originalPrincipalPaise(loan));
      if(!loan.originalLoanDate){var originalDate=originalStartDate(loan);if(originalDate)loan.originalLoanDate=originalDate;}
      return loan;
    });
    s.cashBook=obj(s.cashBook);s.settings=obj(s.settings);s.appLock=obj(s.appLock);s.syncMeta=obj(s.syncMeta);s.backupMetadata=obj(s.backupMetadata);
    return s;
  }

  function loanHistoryReference(entry){return str(entry&&(entry.bid||entry.loanId||entry.loanProfileId||entry.borrowerId));}

  function repairRecoveryRelationships(input,options){
    options=options||{};
    var state=normalizeState(input),exact=Object.create(null),aliases=Object.create(null),ambiguous=Object.create(null),aliasSource=Object.create(null);
    var report={totalLoans:state.borrowers.length,totalHistory:state.entryLog.length,directValidLinks:0,validLinks:0,orphanCount:0,repairedLinks:0,unrepairableLinks:0,missingReference:0,repairs:[],unrepairable:[],ambiguousAliases:[],duplicateLoanCount:0,duplicateLoanNumbers:[],duplicateSource:'backup',stagingDuplicateCount:0,stagingDuplicateNumbers:[],stagingSource:'staging'};
    function canonical(loan,index){return legacyId(loan,index,'loan');}
    function addAlias(alias,target,source){
      alias=str(alias);target=str(target);if(!alias||!target||alias===target||exact[alias])return;
      if(aliases[alias]&&aliases[alias]!==target){ambiguous[alias]=1;delete aliases[alias];delete aliasSource[alias];return;}
      if(!ambiguous[alias]){aliases[alias]=target;aliasSource[alias]=source||'loan alias';}
    }
    var loanNumberGroups=Object.create(null);
    state.borrowers=state.borrowers.map(function(loan,index){
      loan=clone(loan);delete loan.recoveryStagingLoanNumber;
      var number=str(loan.loanno||loan.loanNumber).trim();
      if(number){var key=number.toLowerCase();if(!loanNumberGroups[key])loanNumberGroups[key]={loanNumber:number,items:[]};loanNumberGroups[key].items.push({loan:loan,index:index,id:canonical(loan,index)});}
      return loan;
    });
    Object.keys(loanNumberGroups).forEach(function(key){
      var group=loanNumberGroups[key];if(group.items.length<2)return;
      report.duplicateLoanCount+=group.items.length-1;
      report.duplicateLoanNumbers.push({loanNumber:group.loanNumber,count:group.items.length,loanIds:group.items.map(function(x){return x.id;}),source:'backup',suggestedRepair:'Keep the original number on the first loan and assign a unique loan number to each additional loan after reviewing borrower and dates.'});
      group.items.forEach(function(item,position){if(position)item.loan.recoveryStagingLoanNumber=group.loanNumber+'__RECOVERY_'+(position+1)+'_'+fastHash(item.id).slice(0,6);});
    });
    state.borrowers.forEach(function(loan,index){exact[canonical(loan,index)]=canonical(loan,index);});
    state.borrowers.forEach(function(loan,index){
      var target=canonical(loan,index);
      ['loanProfileId','loanId','legacyId','legacyLoanId','oldLoanId','previousLoanId','previousId','renewedFromLoanId','parentLoanId','sourceLoanId'].forEach(function(field){addAlias(loan[field],target,field);});
      ['previousLoanIds','legacyLoanIds','oldLoanIds','migrationIds'].forEach(function(field){arr(loan[field]).forEach(function(id){addAlias(id,target,field);});});
    });
    function consumeMappings(value,source){
      if(Array.isArray(value)){value.forEach(function(row){row=obj(row);addAlias(row.legacy_id||row.legacyId||row.oldId||row.fromId||row.sourceId,row.canonical_id||row.canonicalId||row.newId||row.toId||row.targetId,source);});return;}
      value=obj(value);Object.keys(value).forEach(function(oldId){var row=value[oldId],newId=row&&typeof row==='object'?(row.canonical_id||row.canonicalId||row.newId||row.toId||row.targetId):row;addAlias(oldId,newId,source);});
    }
    consumeMappings(options.idMappings,'migration ID map');
    Object.keys(aliases).forEach(function(oldId){
      var target=aliases[oldId],seen=Object.create(null);
      while(!exact[target]&&aliases[target]&&!seen[target]){seen[target]=1;target=aliases[target];}
      if(exact[target])aliases[oldId]=target;
      else{delete aliases[oldId];delete aliasSource[oldId];}
    });
    Object.keys(ambiguous).forEach(function(id){report.ambiguousAliases.push(id);});
    state.entryLog=state.entryLog.map(function(entry,index){
      entry=obj(entry);var ref=loanHistoryReference(entry),entryId=legacyId(entry,index,'entry');
      if(!ref){report.missingReference++;return entry;}
      if(exact[ref]){report.directValidLinks++;report.validLinks++;return entry;}
      report.orphanCount++;
      var mapped=aliases[ref];
      if(mapped&&exact[mapped]){
        var repaired=clone(entry);repaired.legacyLoanReference=ref;repaired.bid=mapped;
        if(repaired.loanId!==undefined)repaired.loanId=mapped;
        if(repaired.loanProfileId!==undefined)repaired.loanProfileId=mapped;
        if(repaired.borrowerId!==undefined&&str(repaired.borrowerId)===ref)repaired.borrowerId=mapped;
        repaired.relationshipRepair={status:'repaired',fromLoanId:ref,toLoanId:mapped,source:aliasSource[ref]||'resolved alias',repairedAt:nowIso()};
        report.repairedLinks++;report.validLinks++;report.repairs.push({historyId:entryId,fromLoanId:ref,toLoanId:mapped,source:aliasSource[ref]||'resolved alias'});
        return repaired;
      }
      var preserved=clone(entry);preserved.relationshipRepair={status:'unrepairable',loanId:ref,reason:ambiguous[ref]?'ambiguous loan alias':'loan record not found',checkedAt:nowIso()};
      report.unrepairableLinks++;report.unrepairable.push({historyId:entryId,loanId:ref,reason:preserved.relationshipRepair.reason});
      return preserved;
    });
    report.warnings=[];
    if(report.repairedLinks)report.warnings.push(report.repairedLinks+' history relationship(s) repaired in recovery staging');
    if(report.unrepairableLinks)report.warnings.push(report.unrepairableLinks+' history relationship(s) could not be linked and were preserved with warnings');
    if(report.ambiguousAliases.length)report.warnings.push(report.ambiguousAliases.length+' ambiguous loan alias(es) were not guessed');
    if(report.duplicateLoanCount)report.warnings.push(report.duplicateLoanCount+' duplicate loan number record(s) found in the backup; temporary unique staging numbers were used for validation');
    return {state:state,report:report};
  }

  function validateLegacyState(input,options){
    options=options||{};
    var state=normalizeState(input),critical=[],warnings=[];
    var loanIds=Object.create(null),customerIds=Object.create(null),entryIds=Object.create(null);
    state.customers.forEach(function(c,i){var id=legacyId(c,i,'customer');if(customerIds[id])critical.push('duplicate customer ID '+id);customerIds[id]=1;});
    state.borrowers.forEach(function(b,i){
      var id=legacyId(b,i,'loan');if(loanIds[id])critical.push('duplicate loan ID '+id);loanIds[id]=1;
      try{originalPrincipalPaise(b);}catch(e){critical.push(id+': '+e.message);}
      if(!originalStartDate(b))warnings.push(id+': original start date missing');
    });
    state.entryLog.forEach(function(e,i){
      var id=legacyId(e,i,'entry');if(entryIds[id])critical.push('duplicate history ID '+id);entryIds[id]=1;
      var bid=loanHistoryReference(e);
      if(bid&&!loanIds[bid]){
        var stagedWarning=e.relationshipRepair&&e.relationshipRepair.status==='unrepairable';
        if(options.allowOrphanHistory||stagedWarning)warnings.push('orphan history preserved with warning '+id+' -> loan '+bid);
        else critical.push('orphan history '+id+' -> loan '+bid);
      }
      try{entryMoney(e);}catch(err){critical.push(id+': '+err.message);}
    });
    return {state:state,counts:stateCounts(state),totals:stateTotals(state),critical:Array.from(new Set(critical)),warnings:Array.from(new Set(warnings))};
  }

  var SCHEMA_SQL=`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY CHECK(version>0),name TEXT NOT NULL UNIQUE,checksum_sha256 TEXT NOT NULL,applied_at TEXT NOT NULL,app_version TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS migration_runs(id TEXT PRIMARY KEY,from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('staging','validated','committed','rolled_back','failed')),source_checksum TEXT NOT NULL,staged_checksum TEXT,counts_json TEXT NOT NULL,totals_json TEXT NOT NULL,warnings_json TEXT NOT NULL DEFAULT '[]',error_text TEXT,started_at TEXT NOT NULL,finished_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY,legacy_id TEXT UNIQUE,name TEXT NOT NULL,agent_name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',currency_code TEXT NOT NULL DEFAULT 'INR',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS app_users(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,username TEXT NOT NULL COLLATE NOCASE,display_name TEXT NOT NULL,mobile TEXT NOT NULL DEFAULT '',device_id TEXT NOT NULL DEFAULT '',role TEXT NOT NULL,status TEXT NOT NULL,pin_hash TEXT,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(business_id,legacy_id),UNIQUE(business_id,username)) STRICT;
CREATE TABLE IF NOT EXISTS areas(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,parent_area_id TEXT REFERENCES areas(id) DEFERRABLE INITIALLY DEFERRED,area_type TEXT NOT NULL CHECK(area_type IN('main','sub')),name TEXT NOT NULL COLLATE NOCASE,collection_weekday INTEGER CHECK(collection_weekday BETWEEN 0 AND 6),raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(business_id,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS borrowers(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,customer_number TEXT,full_name TEXT NOT NULL,kyc_number TEXT,normalized_match_key TEXT,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),UNIQUE(business_id,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS borrower_contacts(id TEXT PRIMARY KEY,borrower_id TEXT NOT NULL REFERENCES borrowers(id),kind TEXT NOT NULL,value TEXT NOT NULL,normalized_value TEXT NOT NULL,is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN(0,1)),created_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(borrower_id,kind,normalized_value)) STRICT;
CREATE TABLE IF NOT EXISTS borrower_addresses(id TEXT PRIMARY KEY,borrower_id TEXT NOT NULL REFERENCES borrowers(id),area_id TEXT REFERENCES areas(id),address_text TEXT NOT NULL DEFAULT '',latitude_e7 INTEGER,longitude_e7 INTEGER,is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN(0,1)),valid_from TEXT NOT NULL,valid_to TEXT,deleted_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS loans(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),borrower_id TEXT NOT NULL REFERENCES borrowers(id),legacy_id TEXT NOT NULL,loan_number TEXT NOT NULL,product_type TEXT NOT NULL,status TEXT NOT NULL,original_loan_amount_paise INTEGER NOT NULL CHECK(original_loan_amount_paise>=0),original_start_date TEXT NOT NULL,contractual_end_date TEXT,opening_paid_paise INTEGER NOT NULL DEFAULT 0 CHECK(opening_paid_paise>=0),opening_paid_date TEXT,current_area_id TEXT REFERENCES areas(id),raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),UNIQUE(business_id,legacy_id),UNIQUE(business_id,loan_number)) STRICT;
CREATE TABLE IF NOT EXISTS loan_relationships(id TEXT PRIMARY KEY,from_loan_id TEXT NOT NULL REFERENCES loans(id),to_loan_id TEXT NOT NULL REFERENCES loans(id),relation_type TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(from_loan_id<>to_loan_id),UNIQUE(from_loan_id,to_loan_id,relation_type)) STRICT;
CREATE TABLE IF NOT EXISTS loan_term_versions(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),version_no INTEGER NOT NULL CHECK(version_no>0),effective_from TEXT NOT NULL,effective_to TEXT,period_unit TEXT NOT NULL,period_count INTEGER NOT NULL CHECK(period_count>0),interest_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(interest_rate_bps>=0),interest_basis TEXT NOT NULL,scheduled_payment_paise INTEGER,default_payment_paise INTEGER,commission_paise INTEGER NOT NULL DEFAULT 0,document_fee_paise INTEGER NOT NULL DEFAULT 0,net_disbursed_paise INTEGER NOT NULL DEFAULT 0,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(loan_id,version_no)) STRICT;
CREATE TABLE IF NOT EXISTS loan_documents(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),document_type TEXT NOT NULL,display_name TEXT NOT NULL,content_uri TEXT,content_sha256 TEXT,size_bytes INTEGER,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS loan_schedules(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),term_version_id TEXT REFERENCES loan_term_versions(id),schedule_type TEXT NOT NULL,collection_weekday INTEGER CHECK(collection_weekday BETWEEN 0 AND 6),starts_on TEXT NOT NULL,ends_on TEXT,timezone TEXT NOT NULL,status TEXT NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS schedule_items(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES loan_schedules(id),sequence_no INTEGER NOT NULL CHECK(sequence_no>0),due_date TEXT NOT NULL,principal_due_paise INTEGER NOT NULL DEFAULT 0,interest_due_paise INTEGER NOT NULL DEFAULT 0,fee_due_paise INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(schedule_id,sequence_no)) STRICT;
CREATE TABLE IF NOT EXISTS financial_transactions(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),loan_id TEXT REFERENCES loans(id),borrower_id TEXT REFERENCES borrowers(id),legacy_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),transaction_type TEXT NOT NULL,business_date TEXT NOT NULL,occurred_at TEXT NOT NULL,gross_paise INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('posted','reversed','tombstone')),source TEXT NOT NULL,idempotency_key TEXT NOT NULL,reverses_transaction_id TEXT REFERENCES financial_transactions(id),supersedes_transaction_id TEXT REFERENCES financial_transactions(id),raw_json TEXT NOT NULL,row_checksum TEXT NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(business_id,legacy_id,revision),UNIQUE(business_id,idempotency_key)) STRICT;
CREATE TABLE IF NOT EXISTS transaction_allocations(id TEXT PRIMARY KEY,transaction_id TEXT NOT NULL REFERENCES financial_transactions(id),component TEXT NOT NULL,amount_paise INTEGER NOT NULL,period_start TEXT,period_end TEXT,principal_before_paise INTEGER,principal_after_paise INTEGER,balance_after_paise INTEGER,calculation_rule_version TEXT NOT NULL,raw_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS payment_tenders(id TEXT PRIMARY KEY,transaction_id TEXT NOT NULL REFERENCES financial_transactions(id),tender_type TEXT NOT NULL,amount_paise INTEGER NOT NULL CHECK(amount_paise>=0),reference_number TEXT,raw_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS loan_events(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),event_type TEXT NOT NULL,event_date TEXT NOT NULL,occurred_at TEXT NOT NULL,from_status TEXT,to_status TEXT,effective_until TEXT,related_transaction_id TEXT REFERENCES financial_transactions(id),reason TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,business_date TEXT NOT NULL,amount_paise INTEGER NOT NULL CHECK(amount_paise>=0),payment_mode TEXT NOT NULL,category TEXT NOT NULL,area_legacy_id TEXT,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(business_id,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS non_account_transactions(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,business_date TEXT NOT NULL,transaction_type TEXT NOT NULL,amount_paise INTEGER NOT NULL CHECK(amount_paise>=0),payment_mode TEXT NOT NULL,area_legacy_id TEXT,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(business_id,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,loan_id TEXT REFERENCES loans(id),legacy_id TEXT NOT NULL,reminder_type TEXT NOT NULL,scheduled_at TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS upi_accounts(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,label TEXT NOT NULL,vpa TEXT NOT NULL,icon TEXT NOT NULL DEFAULT '',qr_payload TEXT,is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN(0,1)),raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(business_id,legacy_id),UNIQUE(business_id,vpa)) STRICT;
CREATE TABLE IF NOT EXISTS cashbook_reconciliations(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),area_legacy_id TEXT,business_date TEXT NOT NULL,opening_paise INTEGER NOT NULL,closing_paise INTEGER NOT NULL,variance_paise INTEGER NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(business_id,area_legacy_id,business_date)) STRICT;
CREATE TABLE IF NOT EXISTS report_snapshots(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),legacy_id TEXT NOT NULL,report_type TEXT NOT NULL,period_start TEXT,period_end TEXT,ledger_revision TEXT NOT NULL,inputs_json TEXT NOT NULL,outputs_json TEXT NOT NULL,checksum_sha256 TEXT NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(business_id,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS app_settings(business_id TEXT NOT NULL REFERENCES businesses(id),setting_key TEXT NOT NULL,value_json TEXT NOT NULL,value_type TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(business_id,setting_key)) STRICT;
CREATE TABLE IF NOT EXISTS backup_runs(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),backup_type TEXT NOT NULL,status TEXT NOT NULL,schema_version INTEGER NOT NULL,app_version TEXT NOT NULL,record_counts_json TEXT NOT NULL,totals_json TEXT NOT NULL,database_checksum_sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,storage_space TEXT NOT NULL,remote_file_id TEXT,remote_revision_id TEXT,started_at TEXT NOT NULL,completed_at TEXT,error_text TEXT) STRICT;
CREATE TABLE IF NOT EXISTS backup_record_manifest(backup_run_id TEXT NOT NULL REFERENCES backup_runs(id),table_name TEXT NOT NULL,record_id TEXT NOT NULL,row_version INTEGER NOT NULL,row_checksum_sha256 TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(backup_run_id,table_name,record_id)) STRICT;
CREATE TABLE IF NOT EXISTS sync_queue(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),entity_table TEXT NOT NULL,entity_id TEXT NOT NULL,operation TEXT NOT NULL,row_version INTEGER NOT NULL,payload_checksum TEXT NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(entity_table,entity_id,row_version)) STRICT;
CREATE TABLE IF NOT EXISTS sync_cursors(business_id TEXT NOT NULL REFERENCES businesses(id),device_id TEXT NOT NULL,remote_cursor TEXT NOT NULL DEFAULT '',last_pushed_at TEXT,last_pulled_at TEXT,last_verified_checksum TEXT,PRIMARY KEY(business_id,device_id)) STRICT;
CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY,entity_table TEXT NOT NULL,entity_id TEXT NOT NULL,local_version INTEGER NOT NULL,remote_version INTEGER NOT NULL,local_checksum TEXT NOT NULL,remote_checksum TEXT NOT NULL,status TEXT NOT NULL,resolution_json TEXT,created_at TEXT NOT NULL,resolved_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS restore_runs(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),source_type TEXT NOT NULL,source_file_id TEXT,source_checksum TEXT NOT NULL,emergency_snapshot_key TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,before_counts_json TEXT NOT NULL,incoming_counts_json TEXT NOT NULL,after_counts_json TEXT,before_totals_json TEXT NOT NULL,after_totals_json TEXT,warnings_json TEXT NOT NULL DEFAULT '[]',error_text TEXT,started_at TEXT NOT NULL,completed_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),actor_legacy_id TEXT,device_id TEXT,action TEXT NOT NULL,entity_table TEXT NOT NULL,entity_id TEXT,transaction_id TEXT REFERENCES financial_transactions(id),before_checksum TEXT,after_checksum TEXT,amount_paise INTEGER,reason TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',occurred_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS legacy_id_map(entity_type TEXT NOT NULL,legacy_id TEXT NOT NULL,canonical_id TEXT NOT NULL,source_key TEXT NOT NULL,source_checksum TEXT NOT NULL,PRIMARY KEY(entity_type,legacy_id)) STRICT;
CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),entity_table TEXT NOT NULL,entity_id TEXT NOT NULL,deleted_at TEXT NOT NULL,deleted_by_legacy_id TEXT,reason TEXT NOT NULL,row_version INTEGER NOT NULL,UNIQUE(entity_table,entity_id,row_version)) STRICT;
CREATE TABLE IF NOT EXISTS integrity_snapshots(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),reason TEXT NOT NULL,schema_version INTEGER NOT NULL,counts_json TEXT NOT NULL,totals_json TEXT NOT NULL,relationship_errors INTEGER NOT NULL DEFAULT 0,checksum_sha256 TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS migration_staging(id TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_index INTEGER NOT NULL,entity_type TEXT NOT NULL,legacy_id TEXT,raw_json TEXT NOT NULL,row_checksum TEXT NOT NULL,migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),UNIQUE(migration_run_id,source_key,source_index)) STRICT;
CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,payload_checksum_sha256 TEXT NOT NULL,counts_json TEXT NOT NULL,totals_json TEXT NOT NULL,schema_version INTEGER NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS state_versions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,payload_checksum_sha256 TEXT NOT NULL,counts_json TEXT NOT NULL,totals_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS entity_state(entity_type TEXT NOT NULL,legacy_id TEXT NOT NULL,raw_json TEXT NOT NULL,row_checksum TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,PRIMARY KEY(entity_type,legacy_id)) STRICT;
CREATE INDEX IF NOT EXISTS idx_areas_parent ON areas(parent_area_id,deleted_at);
CREATE INDEX IF NOT EXISTS idx_borrowers_name ON borrowers(business_id,full_name COLLATE NOCASE,deleted_at);
CREATE INDEX IF NOT EXISTS idx_loans_borrower_status ON loans(borrower_id,status,deleted_at);
CREATE INDEX IF NOT EXISTS idx_tx_loan_date ON financial_transactions(loan_id,business_date,occurred_at,id);
CREATE INDEX IF NOT EXISTS idx_tx_legacy_revision ON financial_transactions(legacy_id,revision DESC);
CREATE INDEX IF NOT EXISTS idx_tx_type_status ON financial_transactions(business_id,transaction_type,status,business_date);
CREATE INDEX IF NOT EXISTS idx_alloc_tx_component ON transaction_allocations(transaction_id,component);
CREATE INDEX IF NOT EXISTS idx_events_loan_date ON loan_events(loan_id,event_date,occurred_at);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_table,entity_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_sync_pending ON sync_queue(status,next_attempt_at,created_at);
CREATE TRIGGER IF NOT EXISTS tx_no_update BEFORE UPDATE ON financial_transactions BEGIN SELECT RAISE(ABORT,'financial transaction is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tx_no_delete BEFORE DELETE ON financial_transactions BEGIN SELECT RAISE(ABORT,'financial transaction must be reversed'); END;
CREATE TRIGGER IF NOT EXISTS allocation_no_update BEFORE UPDATE ON transaction_allocations BEGIN SELECT RAISE(ABORT,'transaction allocation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS allocation_no_delete BEFORE DELETE ON transaction_allocations BEGIN SELECT RAISE(ABORT,'transaction allocation must not be deleted'); END;
CREATE TRIGGER IF NOT EXISTS loan_origin_no_update BEFORE UPDATE OF original_loan_amount_paise,original_start_date ON loans WHEN OLD.original_loan_amount_paise<>NEW.original_loan_amount_paise OR OLD.original_start_date<>NEW.original_start_date BEGIN SELECT RAISE(ABORT,'original loan amount and start date are immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE VIEW IF NOT EXISTS v_current_financial_transactions AS SELECT t.* FROM financial_transactions t JOIN(SELECT business_id,legacy_id,MAX(revision) revision FROM financial_transactions GROUP BY business_id,legacy_id)x ON x.business_id=t.business_id AND x.legacy_id=t.legacy_id AND x.revision=t.revision WHERE t.status='posted';
CREATE VIEW IF NOT EXISTS v_loan_ledger_totals AS SELECT z.*,z.opening_paid_paise+z.receipt_paise total_paid_paise,z.original_loan_amount_paise+z.topup_paise-z.principal_paid_paise-z.opening_paid_paise-z.writeoff_paise calculated_balance_paise FROM(SELECT l.id loan_id,l.legacy_id,l.original_loan_amount_paise,COALESCE((SELECT SUM(a.amount_paise) FROM transaction_allocations a JOIN v_current_financial_transactions t ON t.id=a.transaction_id WHERE t.loan_id=l.id AND t.transaction_type='topup' AND a.component='principal'),0) topup_paise,COALESCE((SELECT SUM(a.amount_paise) FROM transaction_allocations a JOIN v_current_financial_transactions t ON t.id=a.transaction_id WHERE t.loan_id=l.id AND t.transaction_type IN('payment','ots_payment') AND a.component='principal'),0) principal_paid_paise,COALESCE((SELECT SUM(a.amount_paise) FROM transaction_allocations a JOIN v_current_financial_transactions t ON t.id=a.transaction_id WHERE t.loan_id=l.id AND a.component='opening_paid'),0) opening_paid_paise,COALESCE((SELECT SUM(a.amount_paise) FROM transaction_allocations a JOIN v_current_financial_transactions t ON t.id=a.transaction_id WHERE t.loan_id=l.id AND a.component='writeoff'),0) writeoff_paise,COALESCE((SELECT SUM(t.gross_paise) FROM v_current_financial_transactions t WHERE t.loan_id=l.id AND t.transaction_type IN('payment','ots_payment')),0) receipt_paise FROM loans l)z;
`;

  function currentLoanStatus(b){
    if(b.permanentClosed||b.finalClosed||b.paidOff||b.closureLocked||b.completed)return b.closureType==='ots_closed'?'ots_closed':'paid_off';
    if(b.closed||b.collectionDone||b.ignored)return 'temporarily_closed';
    return 'active';
  }

  function weekday(day){return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].indexOf(str(day));}
  function phone(v){return str(v).replace(/[^0-9+]/g,'');}
  function productType(b){
    var t=str(b.loanType).toLowerCase();
    if(t.indexOf('weekly')>=0&&b.isInterest)return 'weekly_interest';
    if(t.indexOf('monthly')>=0&&b.isInterest)return 'monthly_interest';
    if(b.isInterest)return 'interest';
    if(t.indexOf('emi')>=0)return 'emi';
    if(t.indexOf('month')>=0)return 'monthly';
    return 'weekly';
  }

  function buildMigrationPlan(input,context){
    context=context||{};var checked=validateLegacyState(input,{allowOrphanHistory:!!context.allowOrphanHistory});if(checked.critical.length)return {validation:checked,statements:[]};
    var s=checked.state,statements=[],now=nowIso(),businessId=context.businessId||'00000000-0000-4000-8000-000000000001';
    var businessName=str(s.settings.company||context.company||'VasoolBook');
    function add(statement,values){statements.push({statement:statement,values:values||[]});}
    add('INSERT INTO businesses(id,legacy_id,name,agent_name,phone,timezone,currency_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[businessId,'default',businessName,str(s.settings.agent),str(s.settings.phone),'Asia/Kolkata','INR',now,now]);
    var areaMap=Object.create(null),customerMap=Object.create(null),loanMap=Object.create(null);
    s.areas.forEach(function(a,i){var raw=typeof a==='string'?{name:a}:a,lid=legacyId(raw,i,'area'),id=uuid();areaMap[lid]=id;areaMap[str(raw.name).toLowerCase()]=id;add('INSERT INTO areas(id,business_id,legacy_id,parent_area_id,area_type,name,collection_weekday,raw_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,businessId,lid,null,raw.areaType==='sub'?'sub':'main',str(raw.name||a),weekday(raw.day)>=0?weekday(raw.day):null,JSON.stringify(raw),now,now]);});
    s.customers.forEach(function(c,i){var lid=legacyId(c,i,'customer'),id=uuid();customerMap[lid]=id;customerMap[str(c.customerId)]=id;add('INSERT INTO borrowers(id,business_id,legacy_id,customer_number,full_name,kyc_number,normalized_match_key,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)',[id,businessId,lid,str(c.custNo)||null,str(c.name)||'Unknown',str(c.kycNo)||null,str(c.matchKey)||null,JSON.stringify(c),str(c.createdAt||now),str(c.updatedAt||now)]);if(c.phone)add('INSERT INTO borrower_contacts(id,borrower_id,kind,value,normalized_value,is_primary,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),id,'primary_phone',str(c.phone),phone(c.phone),1,now]);if(c.phone2)add('INSERT INTO borrower_contacts(id,borrower_id,kind,value,normalized_value,is_primary,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),id,'secondary_phone',str(c.phone2),phone(c.phone2),0,now]);});
    s.borrowers.forEach(function(b,i){
      var lid=legacyId(b,i,'loan'),customerLegacy=str(b.customerId||b.custId),borrowerId=customerMap[customerLegacy];
      if(!borrowerId){borrowerId=uuid();customerLegacy='loan-borrower:'+lid;customerMap[customerLegacy]=borrowerId;add('INSERT INTO borrowers(id,business_id,legacy_id,customer_number,full_name,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,1)',[borrowerId,businessId,customerLegacy,str(b.custNo)||null,str(b.name)||'Unknown',JSON.stringify({migratedFromLoan:lid,name:b.name,phone:b.phone,area:b.area}),str(b.createdAt||now),str(b.updatedAt||now)]);if(b.phone)add('INSERT INTO borrower_contacts(id,borrower_id,kind,value,normalized_value,is_primary,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),borrowerId,'primary_phone',str(b.phone),phone(b.phone),1,now]);}
      var loanId=uuid();loanMap[lid]=loanId;var areaId=areaMap[str(b.areaId)]||areaMap[str(b.area).toLowerCase()]||null;var start=originalStartDate(b)||'1970-01-01';
      add('INSERT INTO loans(id,business_id,borrower_id,legacy_id,loan_number,product_type,status,original_loan_amount_paise,original_start_date,contractual_end_date,opening_paid_paise,opening_paid_date,current_area_id,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',[loanId,businessId,borrowerId,lid,str(b.recoveryStagingLoanNumber||b.loanno||b.loanNumber)||('LEGACY-'+lid),productType(b),currentLoanStatus(b),originalPrincipalPaise(b),start,str(b.loanend||b.loanEnd)||null,toPaise(b.originalOpeningPaid!==undefined?b.originalOpeningPaid:(b.openingPaidAmount||b.openingPrev||0),'loan.openingPaid'),str(b.openingPaidDate)||null,areaId,JSON.stringify(b),str(b.createdAt||now),str(b.updatedAt||now)]);
      add('INSERT INTO loan_term_versions(id,loan_id,version_no,effective_from,period_unit,period_count,interest_rate_bps,interest_basis,scheduled_payment_paise,default_payment_paise,commission_paise,document_fee_paise,net_disbursed_paise,raw_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[uuid(),loanId,1,start,productType(b).indexOf('month')>=0?'month':'week',Math.max(1,parseInt(b.period||1,10)||1),Math.max(0,Math.round(Number(b.interestRate||0)*100)),b.isInterest?'flat_cycle':'none',toPaise(b.billingAmt||0),toPaise(b.manualPay||0),toPaise(b.commission||0),toPaise(b.docFee||0),Math.max(0,toPaise(b.loan||0)-toPaise(b.commission||0)-toPaise(b.docFee||0)),JSON.stringify(b),now]);
      add('INSERT INTO loan_events(id,loan_id,event_type,event_date,occurred_at,to_status,reason,raw_json) VALUES(?,?,?,?,?,?,?,?)',[uuid(),loanId,'created',start,str(b.createdAt||now),'active','Legacy migration',JSON.stringify({legacyId:lid})]);
    });
    s.borrowers.forEach(function(b,i){
      var toLegacy=legacyId(b,i,'loan'),toLoanId=loanMap[toLegacy];
      ['renewedFromLoanId','previousLoanId','parentLoanId','sourceLoanId'].forEach(function(field){
        var fromLegacy=str(b[field]),fromLoanId=loanMap[fromLegacy];
        if(fromLoanId&&toLoanId&&fromLoanId!==toLoanId)add('INSERT OR IGNORE INTO loan_relationships(id,from_loan_id,to_loan_id,relation_type,created_at) VALUES(?,?,?,?,?)',[uuid(),fromLoanId,toLoanId,field==='renewedFromLoanId'?'renewed_as':'previous_version',now]);
      });
    });
    s.entryLog.forEach(function(e,i){
      var lid=legacyId(e,i,'entry'),loanLegacy=str(e.bid||e.loanId||e.loanProfileId||e.borrowerId),loanId=loanMap[loanLegacy]||null,type=transactionType(e),txId=uuid(),gross=entryMoney(e),checksum=financialSignature(e);
      add('INSERT INTO financial_transactions(id,business_id,loan_id,borrower_id,legacy_id,revision,transaction_type,business_date,occurred_at,gross_paise,status,source,idempotency_key,raw_json,row_checksum,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[txId,businessId,loanId,null,lid,1,type,str(e.date||e.paymentDate||e.paidDate||str(e.ts).slice(0,10)||'1970-01-01'),str(e.ts||e.createdAt||now),gross,'posted','migration','legacy:'+lid+':1',JSON.stringify(e),checksum,str(e.createdAt||e.ts||now)]);
      var principal=toPaise(e.principalComponent||0),interest=toPaise(e.interestComponent||0);
      if(isOpening(e))add('INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,period_start,period_end,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',[uuid(),txId,'opening_paid',gross,null,null,toPaise(e.balance||0),'legacy-preserved-v1',JSON.stringify(e)]);
      else if(isTopup(e))add('INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,period_start,period_end,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',[uuid(),txId,'principal',gross,null,null,toPaise(e.balance||0),'legacy-topup-v1',JSON.stringify(e)]);
      else if(isNonCashAdjustment(e))add('INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,period_start,period_end,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',[uuid(),txId,'writeoff',gross,null,null,toPaise(e.balance||0),'legacy-adjustment-v1',JSON.stringify(e)]);
      else {if(principal===0&&interest===0)principal=gross;if(principal)add('INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,period_start,period_end,principal_before_paise,principal_after_paise,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[uuid(),txId,'principal',principal,str(e.cyclePeriodStart)||null,str(e.cyclePeriodEnd)||null,toPaise(e.prevPrincipal||0),toPaise(e.principalBalanceAfter||e.balance||0),toPaise(e.balance||0),'legacy-preserved-v1',JSON.stringify(e)]);if(interest)add('INSERT INTO transaction_allocations(id,transaction_id,component,amount_paise,period_start,period_end,balance_after_paise,calculation_rule_version,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',[uuid(),txId,'interest',interest,str(e.cyclePeriodStart)||null,str(e.cyclePeriodEnd)||null,toPaise(e.balance||0),'legacy-preserved-v1',JSON.stringify(e)]);var cash=toPaise(e.cashAmt||0),upi=toPaise(e.upiAmt||0);if(cash)add('INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',[uuid(),txId,'cash',cash,null,JSON.stringify(e)]);if(upi)add('INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',[uuid(),txId,'upi',upi,str(e.upiMethod)||null,JSON.stringify(e)]);if(!cash&&!upi&&gross>0)add('INSERT INTO payment_tenders(id,transaction_id,tender_type,amount_paise,reference_number,raw_json) VALUES(?,?,?,?,?,?)',[uuid(),txId,str(e.pay).toLowerCase().indexOf('cash')>=0?'cash':(str(e.pay).toLowerCase().match(/upi|gpay|phonepe|online/)?'upi':'other'),gross,str(e.pay)||null,JSON.stringify(e)]);}
    });
    s.expenses.forEach(function(e,i){var lid=legacyId(e,i,'expense');add('INSERT INTO expenses(id,business_id,legacy_id,business_date,amount_paise,payment_mode,category,area_legacy_id,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',[uuid(),businessId,lid,str(e.date)||'1970-01-01',toPaise(e.amount||0),str(e.mode||'Cash'),str(e.category||'Other'),str(e.areaId||e.area)||null,JSON.stringify(e),str(e.createdAt||now),str(e.updatedAt||now)]);});
    s.nonAccTxns.forEach(function(e,i){var lid=legacyId(e,i,'nat');add('INSERT INTO non_account_transactions(id,business_id,legacy_id,business_date,transaction_type,amount_paise,payment_mode,area_legacy_id,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',[uuid(),businessId,lid,str(e.date)||'1970-01-01',str(e.type||'cash_in'),toPaise(e.amount||0),str(e.pay||'Cash'),str(e.areaId||e.area)||null,JSON.stringify(e),str(e.ts||now),str(e.updatedAt||e.ts||now)]);});
    s.upiIds.forEach(function(e,i){var raw=typeof e==='string'?{label:e,vpa:e}:e,lid=legacyId(raw,i,'upi');add('INSERT INTO upi_accounts(id,business_id,legacy_id,label,vpa,icon,qr_payload,is_active,raw_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[uuid(),businessId,lid,str(raw.label||raw.vpa||'UPI'),str(raw.vpa||raw.label||lid),str(raw.icon),str(raw.qrPayload)||null,1,JSON.stringify(raw),now,now]);});
    s.reminders.forEach(function(e,i){var lid=legacyId(e,i,'reminder'),loanId=loanMap[str(e.bid)]||null;add('INSERT INTO reminders(id,loan_id,legacy_id,reminder_type,scheduled_at,status,note,raw_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[uuid(),loanId,lid,str(e.type||'payment'),str(e.datetime||e.date||now),'scheduled',str(e.note),JSON.stringify(e),now,now]);});
    Object.keys(s.cashBook).forEach(function(date){var d=obj(s.cashBook[date]);function row(area,x){x=obj(x);add('INSERT INTO cashbook_reconciliations(id,business_id,area_legacy_id,business_date,opening_paise,closing_paise,variance_paise,raw_json,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)',[uuid(),businessId,area||null,date,toPaise(x.openBal||0),toPaise(x.closeBal||0),toPaise((Number(x.closeBal||0)-Number(x.openBal||0))),JSON.stringify(x),str(x.updatedAt||now),str(x.updatedAt||now)]);}row(null,d);Object.keys(obj(d.areas)).forEach(function(a){row(a,d.areas[a]);});});
    Object.keys(s.settings).forEach(function(k){add('INSERT INTO app_settings(business_id,setting_key,value_json,value_type,updated_at,version) VALUES(?,?,?,?,?,1)',[businessId,k,JSON.stringify(s.settings[k]),typeof s.settings[k],now]);});
    s.users.forEach(function(u,i){var lid=legacyId(u,i,'user');add('INSERT INTO app_users(id,business_id,legacy_id,username,display_name,mobile,device_id,role,status,pin_hash,raw_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[uuid(),businessId,lid,str(u.username||lid),str(u.name||u.username||'User'),str(u.mobile),str(u.deviceId),str(u.role||'Agent'),str(u.status||'active'),u.pin?fastHash(str(u.pin)):null,JSON.stringify(u),str(u.createdAt||now),str(u.updatedAt||now)]);});
    s.auditLog.forEach(function(e,i){add('INSERT INTO audit_log(id,business_id,actor_legacy_id,device_id,action,entity_table,entity_id,before_checksum,after_checksum,amount_paise,reason,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[uuid(),businessId,str(e.userId)||null,str(e.deviceId)||null,str(e.action||'Legacy'),str(e.txnType||'legacy'),str(e.id)||null,null,null,toPaise(e.amount||0),str(e.note),JSON.stringify(e),str(e.ts||now)]);});
    s.collReports.forEach(function(e,i){var lid=legacyId(e,i,'report');add('INSERT INTO report_snapshots(id,business_id,legacy_id,report_type,period_start,period_end,ledger_revision,inputs_json,outputs_json,checksum_sha256,raw_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[uuid(),businessId,lid,str(e.reportType||'collection'),str(e.date)||null,str(e.date)||null,'legacy',JSON.stringify(e),JSON.stringify(e),fastHash(stableStringify(e)),JSON.stringify(e),str(e.savedAt||now)]);});
    return {validation:checked,statements:statements,businessId:businessId};
  }

  function compareMetrics(before,after){
    var mismatches=[];Object.keys(before.counts).forEach(function(k){if(Number(before.counts[k])!==Number(after.counts[k]))mismatches.push('count.'+k+': '+before.counts[k]+' != '+after.counts[k]);});Object.keys(before.totals).forEach(function(k){if(Number(before.totals[k])!==Number(after.totals[k]))mismatches.push('total.'+k+': '+before.totals[k]+' != '+after.totals[k]);});return mismatches;
  }

  function recoveryTimestamp(item){
    // deletedAt is included so a tombstone row (which only ever carries deletedAt, never
    // updatedAt/ts/createdAt) gets a real comparable timestamp instead of always reading
    // as 0 — without it, tombstoneWins() below silently fails to suppress a resurrected
    // record whenever that record itself has no explicit revision field (the normal case).
    var raw=item&&(item.updatedAt||item.modifiedAt||item.ts||item.createdAt||item.savedAt||item.date||item.deletedAt)||'';
    var value=Date.parse(raw);return isNaN(value)?0:value;
  }
  function recoveryRevision(item){var n=Number(item&&(item.revision||item.rowVersion||item.version)||0);return isFinite(n)&&n>0?Math.floor(n):0;}
  function recoveryTombstoneKey(t){return str(t&&(t.kind||t.entityType||t.entity_table))+'|'+str(t&&(t.key||t.entityId||t.entity_id));}
  function mergeRecoveryTombstones(current,sources){
    var map=Object.create(null),out=[];
    function accept(item){
      if(!item||typeof item!=='object')return;
      var key=recoveryTombstoneKey(item);if(!key||key==='|')return;
      var at=map[key];
      if(at===undefined){map[key]=out.length;out.push(clone(item));return;}
      var old=out[at],nr=recoveryRevision(item),or=recoveryRevision(old),nt=recoveryTimestamp(item),ot=recoveryTimestamp(old);
      if(nr>or||(nr===or&&nt>ot))out[at]=clone(item);
    }
    arr(current).forEach(accept);arr(sources).forEach(function(source){arr(source).forEach(accept);});
    return out;
  }
  function tombstoneWins(kind,item,tombstones){
    var key=recoveryKey(kind,item),t=(tombstones||[]).find(function(x){return recoveryTombstoneKey(x)===str(kind)+'|'+key;});
    if(!t)return false;
    var tr=recoveryRevision(t),rr=recoveryRevision(item),tt=recoveryTimestamp(t),rt=recoveryTimestamp(item);
    if(tr&&rr&&tr!==rr)return tr>rr;
    if(tt!==rt)return tt>=rt;
    return true;
  }
  function recoveryKey(kind,item,index){
    item=obj(item);var id=item.id||item.loanProfileId||item.customerId||item.areaId||item.userId;
    if(id!==undefined&&id!==null&&str(id)!=='')return 'id:'+str(id);
    var parts;
    if(kind==='entryLog')parts=[item.bid||item.loanId||item.borrowerId,item.date||item.paymentDate,item.today||item.paidAmount||item.amount,item.paymentPurpose||item.entryType||item.pay,item.loanno];
    else if(kind==='borrowers')parts=[item.loanno,item.customerId||item.custId,item.name,item.phone,originalStartDate(item),item.loanType];
    else if(kind==='customers')parts=[item.custNo,item.name,item.phone,item.phone2];
    else if(kind==='areas')parts=[item.name||item,item.parentAreaId,item.areaType];
    else parts=[item.date,item.name||item.label||item.type,item.amount,item.bid||item.loanId,item.vpa];
    var semantic=parts.map(str).join('|').toLowerCase();
    return semantic.replace(/\|/g,'')?'semantic:'+fastHash(semantic):'anonymous:'+fastHash(stableStringify(item))+(index===undefined?'':':'+index);
  }
  function mergeRecoveryArrays(kind,current,sources,options){
    options=options||{};var merged=[],positions=Object.create(null),added=0,updated=0,duplicates=0,suppressedKeys=Object.create(null),tombstones=options.tombstones||[];
    function accept(item,index,isCurrent){
      if(!item||typeof item!=='object')return;
      var copy=clone(item),key=recoveryKey(kind,copy,index);
      if(tombstoneWins(kind,copy,tombstones)){suppressedKeys[key]=true;return;}
      if(!Object.prototype.hasOwnProperty.call(positions,key)){positions[key]=merged.length;merged.push(copy);if(!isCurrent)added++;return;}
      duplicates++;var at=positions[key],existing=merged[at];
      var cr=recoveryRevision(copy),er=recoveryRevision(existing),ct=recoveryTimestamp(copy),et=recoveryTimestamp(existing);
      if(cr>er||(cr===er&&ct>et)){merged[at]=copy;if(!isCurrent)updated++;}
    }
    arr(current).forEach(function(item,index){accept(item,index,true);});
    arr(sources).forEach(function(source){arr(source).forEach(function(item,index){accept(item,index,false);});});
    return {merged:merged,added:added,updated:updated,duplicatesRemoved:duplicates,suppressedKeys:suppressedKeys,tombstonesApplied:Object.keys(suppressedKeys).length};
  }

  return {SCHEMA_VERSION:SCHEMA_VERSION,DATABASE_NAME:DATABASE_NAME,SCHEMA_SQL:SCHEMA_SQL,uuid:uuid,clone:clone,stableStringify:stableStringify,fastHash:fastHash,sha256:sha256,toPaise:toPaise,fromPaise:fromPaise,isOpening:isOpening,isTopup:isTopup,isNeutral:isNeutral,isNonCashAdjustment:isNonCashAdjustment,transactionType:transactionType,currentLoanStatus:currentLoanStatus,productType:productType,financialSignature:financialSignature,financialRecordFingerprint:financialRecordFingerprint,financialIntegritySnapshot:financialIntegritySnapshot,compareFinancialIntegrity:compareFinancialIntegrity,entryMoney:entryMoney,originalPrincipalPaise:originalPrincipalPaise,originalStartDate:originalStartDate,stateCounts:stateCounts,stateTotals:stateTotals,normalizeState:normalizeState,repairRecoveryRelationships:repairRecoveryRelationships,validateLegacyState:validateLegacyState,buildMigrationPlan:buildMigrationPlan,compareMetrics:compareMetrics,recoveryTimestamp:recoveryTimestamp,recoveryRevision:recoveryRevision,recoveryKey:recoveryKey,recoveryTombstoneKey:recoveryTombstoneKey,mergeRecoveryTombstones:mergeRecoveryTombstones,tombstoneWins:tombstoneWins,mergeRecoveryArrays:mergeRecoveryArrays,nowIso:nowIso};
});
