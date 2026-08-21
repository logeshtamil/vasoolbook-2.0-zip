'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

const context = { Math, Object, parseFloat };
vm.createContext(context);
vm.runInContext(extractFunction('_weeklyInterestBorrowerCardDue'), context);
vm.runInContext(extractFunction('_monthlyInterestBorrowerCardDue'), context);

const currentCycle = Object.freeze({ currentDue: 600, previousPendingDue: 0, interestPending: 600 });
const currentSummary = context._weeklyInterestBorrowerCardDue(currentCycle);
assert.deepStrictEqual({ label: currentSummary.label, amount: currentSummary.amount, hasPending: currentSummary.hasPending }, {
  label: 'Due Amount', amount: 600, hasPending: false
});
assert.ok(Object.isFrozen(currentSummary));
assert.deepStrictEqual(currentCycle, { currentDue: 600, previousPendingDue: 0, interestPending: 600 }, 'summary does not mutate canonical values');

const partialArrear = Object.freeze({ currentDue: 600, previousPendingDue: 250, interestPending: 850 });
const arrearSummary = context._weeklyInterestBorrowerCardDue(partialArrear);
assert.deepStrictEqual({ label: arrearSummary.label, amount: arrearSummary.amount, hasPending: arrearSummary.hasPending }, {
  label: 'Total Due', amount: 850, hasPending: true
});

const partialCurrentCycle = Object.freeze({ currentDue: 350, currentCyclePaid: 250, previousPendingDue: 0, interestPending: 350 });
const partialSummary = context._weeklyInterestBorrowerCardDue(partialCurrentCycle);
assert.deepStrictEqual({ label: partialSummary.label, amount: partialSummary.amount, hasPending: partialSummary.hasPending }, {
  label: 'Total Due', amount: 350, hasPending: true
});

const monthlyCurrent = context._monthlyInterestBorrowerCardDue(currentCycle);
assert.deepStrictEqual({ label: monthlyCurrent.label, amount: monthlyCurrent.amount, hasPending: monthlyCurrent.hasPending }, {
  label: 'Due Amount', amount: 600, hasPending: false
});
const monthlyArrear = context._monthlyInterestBorrowerCardDue(partialArrear);
assert.deepStrictEqual({ label: monthlyArrear.label, amount: monthlyArrear.amount, hasPending: monthlyArrear.hasPending }, {
  label: 'Total Due', amount: 850, hasPending: true
});

const renderStart = source.indexOf('function renderBorrowers(){');
const renderEnd = source.indexOf('// LOAN HISTORY PAGE', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'borrower renderer exists');
const cardStats = source.slice(renderStart, renderEnd);
const weeklyStart = cardStats.indexOf('var _isWeeklyInterest=');
const weeklyEnd = cardStats.indexOf('var _paidAmt=', weeklyStart);
const weeklyCard = cardStats.slice(weeklyStart, weeklyEnd);
assert.ok(weeklyCard.includes('_weeklyInterestBorrowerCardDue(_settle)'), 'weekly card uses the compact canonical summary');
assert.ok(weeklyCard.includes('_monthlyInterestBorrowerCardDue(_settle)'), 'monthly card uses the compact canonical summary');
assert.ok(!weeklyCard.includes('Previous Pending Due'), 'weekly card does not expose previous pending detail');
assert.ok(!weeklyCard.includes('Current Due'), 'weekly card does not expose current due detail');
assert.ok(weeklyCard.includes('_compactCardDue.label'), 'interest cards render one label only');
assert.match(source, /function refreshInterestCard\([\s\S]*?getInterestCycleCalculation/, 'Collect retains canonical detailed calculation');
assert.match(source, /function _renderInterestCalcInfo\([\s\S]*?getInterestCycleCalculation/, 'Info retains canonical detailed calculation');

console.log('Weekly interest borrower-card compact due summary tests passed.');
