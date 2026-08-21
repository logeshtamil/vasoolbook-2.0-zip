'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('www/index.html', 'utf8');
const blocks = [];
const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
while ((match = pattern.exec(html))) {
  const attributes = match[1] || '';
  if (/\bsrc\s*=/.test(attributes) || /type\s*=\s*["']application\/json/i.test(attributes)) continue;
  if (match[2].trim()) blocks.push(match[2]);
}

assert.ok(blocks.length > 0, 'index.html contains inline JavaScript');
blocks.forEach((source, index) => {
  new vm.Script(source, { filename: `www/index.html#inline-script-${index + 1}` });
});

console.log(`HTML inline script syntax passed (${blocks.length} blocks)`);
