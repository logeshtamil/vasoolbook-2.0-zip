'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
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
  throw new Error(`unterminated ${name}`);
}

const context = {
  Number, Math,
  todayStr: () => '2026-08-10',
  cfg: key => key === 'company' ? 'Money Lenders' : '',
  fmtDate: value => ({
    '2026-01-10':'10-Jan-2026',
    '2026-07-10':'10-Jul-2026',
    '2026-08-10':'10-Aug-2026'
  })[value] || value
};
vm.createContext(context);
['_interestPreClosureIntimationLines','_interestPreClosureSavedMessageQuote','_interestPreClosureIntimationMessage','_interestClosureMessageLines']
  .forEach(name => vm.runInContext(extractFunction(name), context));

const borrower = {name:'ANIL KUMAR',area:'NEHRU NAGAR',principalAmt:50000,originalLoanDate:'2026-01-10'};
const quote = {
  isMonthly:true,loanStart:'2026-01-10',periodStart:'2026-07-10',periodEnd:'2026-08-10',date:'2026-08-10',
  currentDue:3000,pendingCyclesDue:9000,interestDue:12000,principal:50000,total:62000,
  cycleTotalDays:31,fixedCycleDue:3000,perDayDue:96.77,usedDays:31,proratedDue:3000
};

const expected = [
  '📋 *Interest Loan Pre-Closure Intimation*',
  '👤 *ANIL KUMAR*',
  '📍 NEHRU NAGAR',
  '💰 Loan Amount: ₹50,000',
  '📅 Loan Start Date: 10-Jan-2026',
  '📅 From–To Date: 10-Jul-2026 → 10-Aug-2026',
  '📅 Pre-Closure Date: 10-Aug-2026',
  '💸 Current Due Amount: ₹3,000',
  '⚠️ Previous Pending Due: ₹9,000',
  '🧾 Total Due Amount: ₹12,000',
  '🏦 Principal Balance: ₹50,000',
  '💰 *Total Pre-Closure Amount: ₹62,000*',
  '────────────',
  '🙏 Please confirm and arrange the pre-closure payment. Thank you.',
  'Money Lenders'
];

assert.deepEqual(Array.from(context._interestPreClosureIntimationLines(borrower, quote)), expected);
assert.equal(context._interestPreClosureIntimationMessage(borrower, quote), expected.join('\n'));

const noPrevious = Array.from(context._interestPreClosureIntimationLines(borrower, Object.assign({}, quote, {
  isMonthly:false,pendingCyclesDue:0,interestDue:3000,total:53000
})));
assert.ok(!noPrevious.some(line => line.includes('Previous Pending Due')), 'zero previous pending is omitted');
assert.ok(!noPrevious.some(line => line.includes('Loan Type')), 'Loan Type is removed');
assert.ok(!noPrevious.some(line => line.includes('Due Period')), 'Due Period is removed');
['Total Cycle Days','Fixed Monthly Due','Fixed Cycle Due','Per-Day Due','Days Used','Prorated Due'].forEach(label => {
  assert.ok(!noPrevious.some(line => line.includes(label)), `${label} is not added outside the requested structure`);
});
assert.equal(new Set(expected).size, expected.length, 'no duplicate lines');
assert.match(extractFunction('sendInterestPreClosureIntimation'), /_interestPreClosureIntimationMessage\(b,q\)/, 'WhatsApp uses canonical formatter');

const savedEntry = {
  isLoanClosure:true,closureMode:'',isFullPaid:false,date:'2026-08-10',preClosureDate:'2026-08-10',
  preClosureRunCycleStart:'2026-07-10',preClosureRunCycleEnd:'2026-08-10',
  preClosureDue:3000,preClosurePreviousPending:9000,preClosureTotalDue:12000,
  principalComponent:50000,totalClosureAmount:62000
};
assert.deepEqual(Array.from(context._interestClosureMessageLines(savedEntry, borrower)), expected, 'saved receipt/share uses the canonical intimation format');

const popupWhatsApp = extractFunction('_buildPopupWhatsAppShare');
assert.match(popupWhatsApp, /_interestClosureMessageLines\(_popEntry,b\)/, 'WhatsApp uses saved canonical lines');
assert.match(extractFunction('_popupReceiptShareText'), /_interestClosureMessageLines\(entry,b\)/, 'Copy and receipt share use saved canonical lines');
assert.match(extractFunction('_buildLogMsg'), /_interestClosureMessageLines\(e,b\)/, 'History/receipt uses saved canonical lines');
assert.match(extractFunction('_txnTextLines'), /_interestClosureMessageLines\(entry,ctx\.b\|\|\{\}\)/, 'transaction copy/share uses saved canonical lines');
assert.match(source, /function shareTxnImage\(\)[\s\S]*?_buildTxnImage\(ctx\.b,ctx\.history,ctx\.phone,ctx\.co,ctx\.bal\)/, 'image share uses the transaction context');

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'weekly-monthly-shared-template','exact-field-order','conditional-previous-pending',
    'loan-type-removed','due-period-removed','extra-breakdown-removed',
    'no-duplicate-lines','whatsapp-canonical-source','copy-canonical-source',
    'image-canonical-source','receipt-canonical-source','saved-values-only'
  ]
}, null, 2));
