'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const C = require('../www/js/vasoolbook-sqlite-core.js');
const source = fs.readFileSync('www/index.html', 'utf8');
function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) { if (source[i] === '{') depth++; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
  throw new Error('Could not extract ' + name);
}
let calculationCalls = 0;
const borrower = { id:'l1', isInterest:true, principalAmt:50000, remainingPrincipal:50000, interestRate:5, loanType:'Monthly Interest', loandate:'2026-08-01', interestCalcStart:'2026-08-01', prevPendingInterest:0, interestCredit:0, cycleAllocations:[] };
const context = {
  window:{ VBSqliteCore:C }, borrowers:[borrower], entryLog:[{ id:'p1', bid:'l1', date:'2026-08-02', ts:'2026-08-02T10:00:00Z', today:2500, interestComponent:2500, cashAmt:2500, cycleId:'2026-08', cycleAllocations:[] }],
  todayStr:() => '2026-08-09', Date, JSON, Object, String, Number, Math,
  getInterestCycleCalculation:(b, ref) => ({ calls:++calculationCalls, rate:b.interestRate, principal:b.remainingPrincipal, ref:ref||'2026-08-09' })
};
vm.createContext(context);
vm.runInContext("var _ibCache={},_ibCacheKey=null,_ibCacheRevision=0,_ibHistorySignatureByBorrower={};", context);
['_ibCacheInvalidate','_ibHistorySignature','_ibBorrowerCacheSignature','_touchInterestLoanRevision','_cachedInterestBreakdown'].forEach(name => vm.runInContext(extractFunction(name), context));

assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-09').calls, 1, 'initial calculation runs once');
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-09').calls, 1, 'unchanged data reuses cache');
borrower.interestRate = 6;
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-09').calls, 2, 'rate change invalidates signature without refresh');
context.entryLog[0].cashAmt = 2000; context.entryLog[0].upiAmt = 500;
context._touchInterestLoanRevision('l1', 'payment-edit');
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-09').calls, 3, 'payment edit invalidates the linked payment-history signature immediately');
borrower.prevPendingInterest = 200;
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-09').calls, 4, 'previous pending change invalidates borrower signature');
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-10').calls, 5, 'reference date participates in cache key');
context._touchInterestLoanRevision('l1', 'payment-edit');
assert.equal(context._cachedInterestBreakdown(borrower, '2026-08-10').calls, 6, 'explicit financial mutation invalidates immediately');
assert.ok(borrower.interestCalcRevision > 0, 'borrower data revision advances after mutation');

assert.match(source, /_ibBorrowerCacheSignature\(b,refDate\)/, 'cache uses full borrower/history signature');
assert.match(source, /_touchInterestLoanRevision\(bid,'loan-action'\)/, 'post-payment/delete/top-up refresh invalidates cache');
assert.match(source, /_touchInterestLoanRevision\(bid,'loan-edit'\)/, 'loan edits invalidate cache');
assert.match(source, /if\(typeof _ibCacheInvalidate==='function'\)_ibCacheInvalidate\(\);/, 'backup/import merge invalidates cache');
console.log(JSON.stringify({ status:'PASS', checks:['principal-rate-type-dates','previous-pending-credit','cycle-allocations','payment-history-revision','discount-topup-fingerprint','reference-date','edit-payment-delete-import-invalidation'] }, null, 2));
