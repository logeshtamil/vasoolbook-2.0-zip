'use strict';

process.env.TZ = 'Asia/Kolkata';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const context = { Date, Math, String, Object, isFinite, isNaN };
vm.createContext(context);
vm.runInContext('var _fmtDateCache={};', context);
vm.runInContext('var _VB_COLLECT_PAYMENT_DATE_IDS={f_date:true,f_date_split:true};', context);
[
  '_parsePaymentDateMs',
  '_displayDateParts',
  'fmtDate',
  'fmtTime',
  'fmtDateTime',
  'fmtDateWithWeekday',
  'parseDisplayDateToIso',
  '_vbFmtDDMMYYYY',
  '_vbDateInputText',
  '_vbDateInputPlaceholder'
].forEach(name => vm.runInContext(extractFunction(name), context));

assert.equal(context.fmtDate('2026-08-02'), '02-Aug-2026');
assert.equal(context.fmtDate('2024-02-29'), '29-Feb-2024');
assert.equal(context.fmtDate('02-Aug-2026'), '02-Aug-2026', 'legacy display dates retain previous style');
assert.equal(context.fmtDate('2026-08-02T14:05:09'), '02-Aug-2026');
assert.equal(context.fmtDateTime('2026-08-02T14:05:09', true), '02-Aug-2026 02:05:09 PM');
assert.match(context.fmtDateWithWeekday('2026-08-02'), /^Sun, 02-Aug-2026$/);
assert.equal(context._vbFmtDDMMYYYY('2026-08-02'), '02/08/2026');
assert.equal(context._vbDateInputText({id:'f_date',value:'2026-08-02'}), '02/08/2026');
assert.equal(context._vbDateInputText({id:'f_date_split',value:'2026-08-02'}), '02/08/2026');
assert.equal(context._vbDateInputText({id:'m_loandate',value:'2026-08-02'}), '02-Aug-2026');
assert.equal(context._vbDateInputPlaceholder({id:'f_date'}), 'DD/MM/YYYY');
assert.equal(context._vbDateInputPlaceholder({id:'m_loandate'}), 'DD-Mmm-YYYY');
assert.equal(context.parseDisplayDateToIso('02082026'), '2026-08-02');
assert.equal(context.parseDisplayDateToIso('02/08/2026'), '2026-08-02');
assert.equal(context.parseDisplayDateToIso('02-Aug-2026'), '2026-08-02');
assert.equal(context.parseDisplayDateToIso('31022026'), '', 'invalid display date rejected');

assert.match(source, /function todayStr\(now\)\{return _localCalendarString\(now==null\?new Date\(\):now\);\}/);
assert.match(source, /function _localCalendarParts\(value\)/);
assert.match(source, /function _localCalendarOrdinal\(value\)/);
assert.match(source, /querySelectorAll\('input\[type="date"\]'\)/);
assert.match(source, /MutationObserver\(function\(records\)/);
assert.match(source, /_VB_COLLECT_PAYMENT_DATE_IDS=\{f_date:true,f_date_split:true\}/);
assert.equal((source.match(/<label>Payment Date<\/label>/g)||[]).length,2,'only Collect single/split fields use Payment Date label');
assert.match(source, /fakeText\.textContent=f\|\|_vbDateInputPlaceholder\(inp\)/);
assert.match(source, /function _mdcFmtSlash\(s\)\{[\s\S]*return s\?fmtDate\(s\):'';/);
assert.doesNotMatch(source, /new Date\([^\n]*\)\.toLocaleString\(/, 'rendered timestamps use fmtDateTime');

console.log('Scoped date display format tests passed.');
