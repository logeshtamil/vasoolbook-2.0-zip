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
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = { String };
vm.createContext(context);
['_messageBoldUnicode', '_messageBoldLabels'].forEach(name => vm.runInContext(extractFunction(name), context));

const formatted = context._messageBoldLabels([
  'Name: ANIL KUMAR',
  'Loan Amount: ₹50,000',
  '📅 Payment Date: 30-Jul-2026',
  '👤 *Borrower Name:* ANIL KUMAR',
  '🙏 Thank you.'
].join('\n'));

assert.ok(formatted.includes('𝐍𝐚𝐦𝐞: ANIL KUMAR'));
assert.ok(formatted.includes('𝐋𝐨𝐚𝐧 𝐀𝐦𝐨𝐮𝐧𝐭: ₹50,000'));
assert.ok(formatted.includes('📅 𝐏𝐚𝐲𝐦𝐞𝐧𝐭 𝐃𝐚𝐭𝐞: 30-Jul-2026'));
assert.ok(formatted.includes('👤 𝐁𝐨𝐫𝐫𝐨𝐰𝐞𝐫 𝐍𝐚𝐦𝐞: ANIL KUMAR'));
assert.ok(formatted.includes('🙏 Thank you.'), 'message body is unchanged');
assert.equal(context._messageBoldLabels(formatted), formatted, 'formatting is idempotent');

console.log(JSON.stringify({status: 'PASS', checks: ['bold-labels', 'values-unchanged', 'idempotent']}, null, 2));
