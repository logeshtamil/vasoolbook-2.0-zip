'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('www/index.html', 'utf8');
const renderStart = source.indexOf('function renderBorrowers(){');
const renderEnd = source.indexOf('// LOAN HISTORY PAGE', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'borrower renderer exists');

const renderer = source.slice(renderStart, renderEnd);
const statsStart = renderer.indexOf('// Due amount loan: show principal / interest / total separately');
const statsEnd = renderer.indexOf("'<div style=\"background:#e4e9f0", statsStart);
assert.ok(statsStart >= 0 && statsEnd > statsStart, 'interest card statistics block exists');

const cardStats = renderer.slice(statsStart, statsEnd);
assert.ok(cardStats.includes('interestLoanCycleDueSnapshot(b)'), 'card uses completed-cycle due calculation');
assert.ok(!cardStats.includes('interestLoanSettlementSnapshot(b)'), 'card excludes running-cycle closure accrual');
assert.ok(cardStats.includes('grid-template-columns:repeat(4,1fr)'), 'previous compact four-column layout restored');
['Principal', 'Interest', 'Paid', 'Balance'].forEach(label => {
  assert.ok(cardStats.includes(`>${label}<`) || cardStats.includes(`?'${label}`), `${label} card type is present`);
});
['principalPaid', 'principalPending', 'interestPending'].forEach(field => {
  assert.ok(cardStats.includes(`_settle.${field}`), `${field} comes from the completed-cycle snapshot`);
});
assert.ok(!cardStats.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), 'recent two-column card layout removed');
assert.ok(!cardStats.includes('grid-column:1/-1'), 'recent full-width Total Due card row removed');
assert.ok(!cardStats.includes('saveState('), 'card rendering does not write financial state');

[
  "collectFrom(\\x27'+_id+'\\x27)",
  "openTopUp(\\x27'+_id+'\\x27)",
  "openEditBorrower(\\x27'+_id+'\\x27)",
  "openInfoSheet(\\x27'+_id+'\\x27)",
  "openAppointmentPopup(\\x27'+_id+'\\x27)",
  "restoreBorrower(\\x27'+_id+'\\x27)",
  "openReminderPopup(\\x27'+_id+'\\x27)"
].forEach(binding => {
  assert.ok(renderer.includes(binding), `${binding.split('(')[0]} action remains wired`);
});
assert.ok(renderer.includes("callBorrowerPhone(\\''+_id+'\\',\\'primary\\')"), 'phone action remains wired');

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'previous-four-column-interest-card',
    'completed-cycle-interest-calculations',
    'closure-accrual-excluded-from-card',
    'principal-interest-paid-balance-types',
    'no-card-state-mutation',
    'collect-action',
    'top-up-action',
    'edit-action',
    'info-action',
    'skip-reopen-actions',
    'whatsapp-reminder-action',
    'phone-action'
  ]
}, null, 2));
