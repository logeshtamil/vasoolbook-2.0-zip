'use strict';

// Verifies the unused, disabled "Upcoming" action button on an Interest Loan's
// Upcoming Due card has been replaced with a working "Top-Up" button, wired
// directly to the existing openTopUp(bid) flow, prelinked to the correct
// borrower id, without disturbing the sibling Edit/Info buttons or the
// non-monthly-interest "Reopen" branch on the same card.

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('www/index.html', 'utf8');

// Locate the Upcoming Due card's action-button row specifically (not any other
// occurrence of similar text elsewhere in the file).
const anchor = source.indexOf("UPCOMING DUE TAB: monthly interest waiting for next cycle");
assert.ok(anchor >= 0, 'Upcoming Due card renderer must exist');
const cardSection = source.slice(anchor, anchor + 6000);

assert.ok(!/disabled[^>]*>Upcoming<\/button>/.test(cardSection), 'the old disabled, non-functional "Upcoming" button must be gone');
assert.ok(!cardSection.includes('cursor:default">Upcoming</button>'), 'no dead/disabled Upcoming button remains on the card');
assert.match(cardSection, /_upcomingFlow\s*\?\s*'<button class="b-act" onclick="event\.stopPropagation\(\);openTopUp\(\\x27'\+_id\+'\\x27\)"[^>]*>Top-Up<\/button>/, 'Top-Up button replaces it, wired to openTopUp(bid) with the correct borrower id and stopPropagation (matching sibling card-action buttons)');
assert.match(cardSection, /:'<button class="b-act" onclick="event\.stopPropagation\(\);reopenUpcomingDue\(\\x27'\+_id\+'\\x27\)"/, 'the non-monthly-interest "Reopen" branch on the same card is unchanged');
assert.match(cardSection, /openEditBorrower\(\\x27'\+_id\+'\\x27\)/, 'sibling Edit button on the card is unchanged');
assert.match(cardSection, /openInfoSheet\(\\x27'\+_id\+'\\x27\)/, 'sibling Info button on the card is unchanged');

// openTopUp itself must remain untouched — it is the existing, already-tested flow;
// this change only adds a new caller, never alters top-up calculation/save behavior.
function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const brace = source.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(functionStart, i + 1);
  }
  throw new Error('Could not extract ' + name);
}
const openTopUpSrc = functionSource('openTopUp');
assert.match(openTopUpSrc, /_topupBid\s*=\s*bid/, 'openTopUp still prelinks the correct borrower/loan id');
assert.match(openTopUpSrc, /if\(!b\.isInterest\)/, 'openTopUp still guards to interest loans only');
assert.match(openTopUpSrc, /\$id\('topupModal'\)\.classList\.add\('open'\)/, 'openTopUp still opens the existing Top-Up modal directly (no intermediate navigation required)');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'dead-upcoming-button-removed',
    'topup-button-wired-to-openTopUp-with-borrower-id',
    'reopen-branch-unchanged',
    'sibling-edit-info-buttons-unchanged',
    'openTopUp-flow-itself-untouched'
  ]
}, null, 2));
