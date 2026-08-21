'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const markerStart = source.indexOf(marker);
  assert.ok(markerStart >= 0, `function ${name} exists`);
  const asyncMarker = `async ${marker}`;
  const asyncStart = source.lastIndexOf(asyncMarker, markerStart);
  const start = asyncStart >= 0 && asyncStart + asyncMarker.length >= markerStart + marker.length
    ? asyncStart
    : markerStart;
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const formatDate = value => {
  const [y,m,d] = String(value || '').slice(0,10).split('-');
  return value ? `${d}/${m}/${y}` : '—';
};

const messageContext = {
  Object, Number, Math, isFinite, borrowers: [],
  fmtDate: formatDate,
  applyMessageTemplate: (type, message) => message
};
vm.createContext(messageContext);
['_discountSettlementSnapshot','_discountSettlementMessage','_discountSettlementCardHtml']
  .forEach(name => vm.runInContext(extractFunction(name), messageContext));

const borrower = {id:'B-DISC',name:'ANIL KUMAR',phone:'9876543210'};
const savedEntry = Object.freeze({
  id:'DISC-1',bid:'B-DISC',name:'ANIL KUMAR',phone:'9876543210',
  isDiscountClosure:true,loanAmt:1000,discountAmount:100,
  amountPaidToday:250,paidBeforeClosure:650,finalSettledAmount:900,
  closureDate:'2026-08-14',date:'2026-08-14',
  netLoanBalance:999999,finalClosureAmt:888888
});

const message = messageContext._discountSettlementMessage(savedEntry, borrower).split('\n');
assert.deepEqual(message, [
  '🔒 *Loan Closure / Discount Settlement*',
  '👤 *ANIL KUMAR*',
  '💰 *Loan Amount:* ₹1,000',
  '🏷️ *Discount Amount:* ₹100',
  '💵 *Amount Paid Today:* ₹250',
  '✅ *Final Adjusted / Settled Amount:* ₹900',
  '📅 *Closure Date:* 14/08/2026',
  '✅ *Loan Closed Successfully*'
]);
assert.equal(message.filter(line => /Balance|Adjustment/.test(line)).length, 0, 'no duplicate balance or adjustment lines');
assert.ok(!message.join('\n').includes('999,999'), 'stale pre-discount balance is ignored');
assert.ok(!message.join('\n').includes('888,888'), 'legacy preview amount is ignored');

const zeroPaid = messageContext._discountSettlementMessage(Object.assign({}, savedEntry, {
  amountPaidToday:0,finalSettledAmount:650
}), borrower).split('\n');
assert.ok(!zeroPaid.some(line => line.includes('Amount Paid Today')), 'zero paid-today line is omitted');
assert.equal(zeroPaid.filter(line => line.includes('Final Adjusted / Settled Amount')).length, 1);

const card = messageContext._discountSettlementCardHtml(savedEntry, borrower);
['Loan Amount','Discount Amount','Amount Paid Today','Final Adjusted / Settled Amount','Closure Date','Loan Closed Successfully']
  .reduce((previous, label) => {
    const current = card.indexOf(label);
    assert.ok(current > previous, `${label} follows saved settlement order`);
    return current;
  }, -1);

function makeSaveContext(failPersistence) {
  const elements = {
    'disc-bid':{value:'B-DISC'},
    'disc-final-amt':{value:'250'},
    'disc-int-reduce':{value:'100'},
    'disc-net-bal-val':{value:'150'},
    'disc-save-btn':{disabled:false,textContent:'Apply Discount & Close Loan'}
  };
  const events = [];
  const context = {
    Object, Number, Math, JSON, Date, Promise, isFinite,
    borrowers:[{id:'B-DISC',name:'ANIL KUMAR',area:'NEHRU NAGAR',phone:'9876543210',loan:1000,prev:650,discount:0}],
    entryLog:[], _discountClosureSaving:false,
    _mumRequire: permission => permission === 'loan.close',
    $id: id => elements[id] || null,
    todayStr: () => '2026-08-14',
    closurePreviousPendingAmount: () => 0,
    uid: () => 'DISC-SAVED',
    fmt: value => Number(value || 0).toLocaleString('en-IN'),
    _persistDiscountClosureForPopup: async () => {
      events.push('persist');
      if (failPersistence) throw new Error('storage unavailable');
      return true;
    },
    _refreshAfterLoanAction: () => events.push('refresh'),
    closeDiscountPopup: () => events.push('close-calculation'),
    openInfoSheet: () => events.push('info'),
    showDiscountSettlementPopup: id => { events.push(`popup:${id}`); return true; },
    showToast: text => events.push(`toast:${text}`),
    saveState: () => events.push('rollback-save')
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('saveDiscountClosure'), context);
  return {context,events,elements};
}

(async () => {
  const success = makeSaveContext(false);
  await success.context.saveDiscountClosure();
  assert.equal(success.context.entryLog.length, 1);
  const saved = success.context.entryLog[0];
  assert.equal(saved.today, 250, 'Cash/Bank keeps exact paid-today amount');
  assert.equal(saved.total, 1000, 'History/Reports keep original loan total');
  assert.equal(saved.discountAmount, 100);
  assert.equal(saved.amountPaidToday, 250);
  assert.equal(saved.finalSettledAmount, 900);
  assert.equal(saved.closureDate, '2026-08-14');
  assert.ok(success.events.indexOf('persist') < success.events.indexOf('popup:DISC-SAVED'), 'popup opens only after persistence');
  assert.equal(success.events.filter(event => event.startsWith('popup:')).length, 1, 'popup opens once');
  assert.equal(success.elements['disc-save-btn'].disabled, false, 'save button resets in finally');

  const failed = makeSaveContext(true);
  await failed.context.saveDiscountClosure();
  assert.equal(failed.context.entryLog.length, 0, 'failed persistence rolls back closure entry');
  assert.equal(failed.context.borrowers[0].closed, undefined, 'failed persistence restores borrower state');
  assert.equal(failed.events.filter(event => event.startsWith('popup:')).length, 0, 'failed save never opens popup');
  assert.equal(failed.elements['disc-save-btn'].disabled, false, 'failed save button resets');

  assert.doesNotMatch(extractFunction('openDiscountPopup'), /showDiscountSettlementPopup/);
  const calcStart = source.indexOf('function calcDiscountClosure(');
  const calcEnd = source.indexOf("var _discountSettlementEntryId=", calcStart);
  assert.ok(calcStart >= 0 && calcEnd > calcStart, 'discount calculation preview section exists');
  assert.doesNotMatch(source.slice(calcStart, calcEnd), /showDiscountSettlementPopup/);
  assert.match(extractFunction('saveDiscountClosure'), /await _persistDiscountClosureForPopup\(\)/);
  assert.match(extractFunction('saveDiscountClosure'), /showDiscountSettlementPopup\(savedClosure\.id\)/);
  assert.match(extractFunction('_ensureDiscountSettlementPopup'), />WhatsApp<|WhatsApp<\/button>/);
  assert.match(extractFunction('_ensureDiscountSettlementPopup'), />Copy<|Copy<\/button>/);
  assert.match(extractFunction('_ensureDiscountSettlementPopup'), />Image Share<|Image Share<\/button>/);
  assert.match(extractFunction('shareDiscountSettlementImage'), /shareReceipt\('','',dataUrl,'image\/png',fileName\)/, 'native image share has no accompanying text');

  console.log(JSON.stringify({
    status:'PASS',
    checks:[
      'final-saved-values-only',
      'zero-payment-line-omitted',
      'no-duplicate-adjustment-lines',
      'whatsapp-copy-image-actions',
      'image-only-native-share',
      'post-persist-popup-only',
      'single-popup-open',
      'preview-edit-refresh-excluded',
      'persistence-failure-rollback',
      'history-report-cash-fields-preserved',
      'button-finally-reset'
    ]
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
