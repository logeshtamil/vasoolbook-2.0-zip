'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const button = {
  textContent:'Save Top-Up',disabled:false,attrs:{},
  setAttribute(name,value){this.attrs[name]=String(value);},
  removeAttribute(name){delete this.attrs[name];}
};
const modal = {classList:{contains:() => true}};
const toasts = [], processing = [];
const context = {
  Promise, String, Error, console,
  _topupSaveBusy:false,_topupBid:null,_topupEditId:null,
  borrowers:[],
  $id:id => id === 'topup-save-btn' ? button : id === 'topupModal' ? modal : null,
  showToast:(message,type) => toasts.push({message,type}),
  _mumRequire:() => true,
  VBProcessing:{
    begin:(key) => {const token={key};processing.push(['begin',key]);return token;},
    end:token => processing.push(['end',token&&token.key]),
    complete:(token,status) => processing.push(['complete',token&&token.key,status])
  }
};
vm.createContext(context);
vm.runInContext(extractFunction('saveTopUp'), context);

function validTopUpHarness(loanType) {
  const monthly = loanType === 'monthly_interest';
  const fields = {
    'topup-save-btn':{textContent:'Save Top-Up',disabled:false,setAttribute(){},removeAttribute(){}},
    topupModal:{classList:{contains:() => false}},
    tu_amount:{value:'10000'},tu_date:{value:'2026-08-05'},tu_due_date:{value:monthly?'2026-09-02':'2026-08-07'},
    tu_rate:{value:'5'},tu_note:{value:'Working capital'},tu_pay:{value:'Cash'}
  };
  const borrower={
    id:'B1',name:'ANIL',area:'AREA 1',phone:'9999999999',loanno:'L1',loanType,isInterest:true,
    loandate:'2026-07-02',loan:50000,principalAmt:50000,remainingPrincipal:50000,
    interestRate:5,interestAmt:2500,period:6,prev:0,topups:[]
  };
  const existingPending={id:'OLD-DUE',bid:'B1',date:'2026-08-02',today:500,interestComponent:500,principalComponent:0};
  const calls={recalc:0,refresh:0,close:0,share:0,split:0};
  let ids=0;
  const sandbox={
    Promise,String,Error,Number,Math,Array,Object,JSON,console,parseFloat,isFinite,
    _topupSaveBusy:false,_topupBid:'B1',_topupEditId:null,_topupPrecedingPayment:null,_topupShareData:null,_tuSplitMode:false,
    borrowers:[borrower],entryLog:[existingPending],
    $id:id => fields[id] || null,
    showToast:() => {},_mumRequire:() => true,
    VBProcessing:{begin:() => ({}),end:() => {},complete:() => {}},todayStr:() => '2026-08-05',
    getInterestBreakdown:() => ({totalDue:2500,periodStart:'2026-08-02',dueDate:monthly?'2026-09-02':'2026-08-07'}),
    _isTopUpEntry:entry => !!entry.isTopUp,
    _tuPayLabel:entry => entry.pay || 'Cash',
    _interestBasePrincipal:b => b.loan,
    _topUpInterestSplit:(b,date,amount) => {
      calls.split += 1;
      return {newPrincipal:b.remainingPrincipal+amount,dueDate:monthly?'2026-09-02':'2026-08-07',daysAfter:2,combinedInterest:3000,
        cycleDays:monthly?31:7,fixedCycleDueBefore:2500,fixedCycleDueAfter:3000,perDayDueBefore:80.65,perDayDueAfter:96.77};
    },
    uid:() => `ID-${++ids}`,_technicalIsoNow:() => '2026-08-05T04:30:00.000Z',
    isBorrowerMonthlyType:b => b.loanType === 'monthly_interest',
    _monthlyFixedCycleDue:() => 3000,effectiveBorrowerLoanType:b => b.loanType,
    recalcInterestLoanFromHistory:() => {calls.recalc += 1;},
    _refreshAfterLoanAction:() => {calls.refresh += 1;},
    closeTopUpModal:() => {calls.close += 1;},openTopUpSharePopup:() => {calls.share += 1;}
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('saveTopUp'), sandbox);
  return Promise.resolve(sandbox.saveTopUp()).then(result => ({result,sandbox,borrower,existingPending,calls}));
}

(async function run(){
  let result=await context.saveTopUp();
  assert.equal(result,false,'missing borrower validation exits safely');
  assert.equal(context._topupSaveBusy,false,'validation failure clears busy state in finally');
  assert.equal(button.disabled,false,'validation failure re-enables Save Top-Up');
  assert.equal(button.attrs['aria-busy'],undefined,'validation failure clears aria-busy');
  assert.deepEqual(processing,[['begin','topup-save'],['end','topup-save']],'processing starts and always ends');

  context._topupSaveBusy=true;
  result=await context.saveTopUp();
  assert.equal(result,false,'duplicate tap is rejected');
  assert.ok(toasts.some(item => /already running/.test(item.message)),'duplicate tap gives immediate feedback');
  context._topupSaveBusy=false;

  context._mumRequire=() => {throw new Error('forced authorization failure');};
  result=await context.saveTopUp();
  assert.equal(result,false,'unexpected error is contained');
  assert.equal(context._topupSaveBusy,false,'exception clears busy state in finally');
  assert.equal(button.disabled,false,'exception re-enables Save Top-Up');
  assert.ok(toasts.some(item => /forced authorization failure/.test(item.message)),'exact blocking error is surfaced safely');

  const saveSource=extractFunction('saveTopUp');
  assert.doesNotMatch(saveSource, /_topupEditingId/,'undeclared edit-state variable is removed');
  assert.match(saveSource, /_mumRequire\(_topupEditId\?'topup\.edit':'topup\.create'\)/,'create/edit RBAC uses the real edit state');
  assert.match(saveSource, /if\(amt<=0\).*return false;/,'invalid amount still stops before mutation');
  assert.match(saveSource, /var split = _topUpInterestSplit\(b,tuDate,amt\)/,'existing Weekly/Monthly calculation remains canonical');
  assert.match(saveSource, /b\.topups\.push\(/,'valid save creates the borrower Top-Up record');
  assert.match(saveSource, /entryLog\.unshift\(/,'valid save creates the linked history record');
  assert.match(saveSource, /recalcInterestLoanFromHistory\(bid\)/,'valid save recalculates from history');
  assert.match(saveSource, /_refreshAfterLoanAction\(bid,true\)/,'valid save persists and refreshes dependent UI/reports');
  assert.match(saveSource, /finally\s*\{/,'cleanup is structurally guaranteed');
  assert.doesNotMatch(source, /\['saveTopUp',\{key:'topup-save'/,'no redundant outer processing wrapper can double-run the save');

  for (const loanType of ['weekly_interest','monthly_interest']) {
    const valid=await validTopUpHarness(loanType);
    assert.equal(valid.result,true,`${loanType} valid save succeeds`);
    assert.equal(valid.borrower.topups.length,1,`${loanType} creates exactly one borrower Top-Up`);
    assert.equal(valid.borrower.principalAmt,60000,`${loanType} principal increases once`);
    assert.equal(valid.borrower.remainingPrincipal,60000,`${loanType} remaining principal increases once`);
    const topupRows=valid.sandbox.entryLog.filter(entry => entry.isTopUp);
    assert.equal(topupRows.length,1,`${loanType} creates exactly one history row`);
    assert.equal(topupRows[0].topupId,valid.borrower.topups[0].id,`${loanType} history is linked to the borrower Top-Up`);
    assert.equal(topupRows[0].currentDueBeforeTopUp,2500,`${loanType} preserves existing pending due snapshot`);
    assert.ok(valid.sandbox.entryLog.includes(valid.existingPending),`${loanType} existing pending history is retained`);
    assert.deepEqual(valid.calls,{recalc:1,refresh:1,close:1,share:1,split:1},`${loanType} recalculates and refreshes once`);
    const restarted=JSON.parse(JSON.stringify({borrowers:valid.sandbox.borrowers,entryLog:valid.sandbox.entryLog}));
    assert.equal(restarted.borrowers[0].topups.length,1,`${loanType} Top-Up survives restart serialization`);
    assert.equal(restarted.entryLog.filter(entry => entry.isTopUp).length,1,`${loanType} linked history survives restart serialization`);
    if(loanType === 'monthly_interest')assert.equal(valid.borrower.fixedMonthlyDue,3000,'Monthly fixed due updates from the existing calculation result');
    else assert.equal(valid.borrower.interestAmt,3000,'Weekly due updates from the existing calculation result');
  }

  console.log(JSON.stringify({status:'PASS',checks:[
    'root-reference-error-fixed','create-edit-rbac','invalid-validation-cleanup','duplicate-tap-guard',
    'exception-finally-cleanup','weekly-valid-save','monthly-valid-save','partial-pending-preserved',
    'canonical-topup-calculation','single-linked-history-entry','immediate-refresh-contract','restart-round-trip'
  ]},null,2));
})().catch(error => {console.error(error);process.exitCode=1;});
