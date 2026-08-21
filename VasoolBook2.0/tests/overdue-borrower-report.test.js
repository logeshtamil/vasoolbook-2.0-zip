'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
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

const context = {
  Object, Math, String, parseInt, parseFloat, isFinite,
  borrowers: [], S: {overdue_weeks_above:'1', overdue_months_above:'0'},
  todayStr: () => '2026-07-22',
  effectiveBorrowerLoanType: b => b.loanType,
  isBorrowerMonthlyType: b => /monthly/.test(b.loanType),
  canonicalBalance: b => b.balance,
  canonicalPaidTotal: b => b.paid,
  canonicalLoanAmount: b => b.loan,
  borrowerWeeklyPayment: b => b.instalment,
  _isClosedPaidOffLoan: b => !!b.locked,
  _dateOnly: s => new Date(`${s}T00:00:00Z`),
  _isoDate: d => d.toISOString().slice(0,10),
  _daysBetween: (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000),
  _cycleMonthDate: (base,n) => {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth()+n);
    return d.toISOString().slice(0,10);
  },
  getInterestBreakdown: b => b.breakdown,
  getInterestCycleCalculation: b => b.breakdown
};
vm.createContext(context);
[
  '_overdueThresholds','_overdueLoanKey','_overdueRegularElapsedPeriods',
  '_overdueRegularRow','_overdueInterestRow','calculateOverdueBorrowerRows'
].forEach(name => vm.runInContext(extractFunction(name), context));

context.borrowers = [
  {id:'W1',loanno:'100',name:'Weekly Due',loanType:'weekly',loan:10000,balance:9000,paid:1000,instalment:1000,period:10,loandate:'2026-07-01',updatedAt:'2026-07-20'},
  {id:'W1-old',loanno:'100',name:'Duplicate Old',loanType:'weekly',loan:10000,balance:10000,paid:0,instalment:1000,period:10,loandate:'2026-07-01',updatedAt:'2026-07-01'},
  {id:'I1',loanno:'200',name:'Interest Due',loanType:'monthly_interest',isInterest:true,balance:50000,breakdown:{totalDue:1500,principal:50000,pendingCycleCount:1,completedCycleCount:1,dueDate:'2026-07-15',cycles:[{idx:1,start:'2026-06-15',end:'2026-07-15',pending:1500}]}},
  {id:'C1',loanno:'300',name:'Closed',loanType:'weekly',loan:10000,balance:5000,paid:5000,instalment:1000,period:10,loandate:'2026-06-01',closed:true}
];

const rows = context.calculateOverdueBorrowerRows('2026-07-22');
assert.equal(rows.length, 2, 'one row per active overdue loan');
const weekly = rows.find(row => row.borrower.id === 'W1');
assert.ok(weekly, 'newest duplicate loan record is retained');
assert.equal(weekly.dueDate, '2026-07-15');
assert.equal(weekly.dueAmount, 2000);
assert.equal(weekly.overdueCount, 2);
assert.equal(weekly.balance, 9000);
const interest = rows.find(row => row.borrower.id === 'I1');
assert.equal(interest.dueAmount, 1500);
assert.equal(interest.overdueCount, 1);
assert.equal(interest.balance, 50000);

assert.match(source, /id="rpt-overdue-card"/);
assert.match(source, /id="overdue-category"/);
assert.match(source, /id="overdue-area"/);
assert.match(source, /id="overdue-period"/);
assert.match(source, /callBorrowerPhone\(button\.dataset\.bid/);
assert.match(source, /overdue_weeks_above:'0'/);
assert.match(source, /overdue_months_above:'0'/);
assert.match(source, /content-visibility:auto/);
assert.match(source, /_overdueVisibleLimit=100/);

console.log(JSON.stringify({
  status:'PASS',
  checks:[
    'weekly-schedule-and-ledger','interest-cycle-allocation','duplicate-loan-suppression',
    'closed-loan-exclusion','persisted-thresholds','category-area-overdue-filters',
    'native-dial-bridge','batched-fast-list'
  ]
}, null, 2));
