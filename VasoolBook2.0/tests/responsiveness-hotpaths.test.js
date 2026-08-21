'use strict';

const assert = require('assert');
const fs = require('fs');

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

const saveScheduler = extractFunction('_rawSaveState');
const saveFlush = extractFunction('_rawSaveStateFlushIfPending');
const dropdownScheduler = extractFunction('scheduleCollectDropdownPosition');
const borrowerRender = extractFunction('renderBorrowers');

assert.match(saveScheduler, /if\(_rawSaveStateTimer\)clearTimeout\(_rawSaveStateTimer\)/);
assert.match(saveScheduler, /_rawSaveStateTimer=setTimeout\(_rawSaveStateFlushIfPending,0\)/);
assert.match(saveFlush, /clearTimeout\(_rawSaveStateTimer\)/);
assert.match(dropdownScheduler, /_collectDropdownPositionFrame/);
assert.match(dropdownScheduler, /requestAnimationFrame/);
assert.match(source, /window\.addEventListener\('scroll',scheduleCollectDropdownPosition,\{passive:true\}\)/);
assert.doesNotMatch(borrowerRender, /_ibCacheInvalidate\(\)|_dotsCacheInvalidate\(\)/);
assert.match(source, /if\(typeof requestIdleCallback==='function'\)requestIdleCallback\(run,\{timeout:900\}\)/);
assert.match(source, /_vbWithTimeout\s*\(\s*_preRenderReceiptBlob\(\)/);

console.log(JSON.stringify({
  status: 'PASS',
  checks: ['coalesced-save-timers', 'frame-batched-dropdown-layout', 'retained-interest-cache-on-search', 'idle-post-save-work', 'bounded-receipt-work']
}, null, 2));
