'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = path.join(__dirname, '..', 'tests');
const files = fs
  .readdirSync(testsDir)
  .filter(name => name.endsWith('.test.js'))
  .sort();

let passed = 0;
const failed = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  if (result.status === 0) {
    passed += 1;
  } else {
    failed.push(file);
  }
}

console.log(`\n${passed}/${files.length} test files passed.`);
if (failed.length) {
  console.log('Failed:');
  failed.forEach(file => console.log(`  - ${file}`));
  process.exit(1);
}
