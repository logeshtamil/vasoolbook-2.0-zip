'use strict';

const assert = require('assert');
const fs = require('fs');
const C = require('../www/js/vasoolbook-sqlite-core.js');

function state(){
  return {
    customers: [{ id: 'c1', name: 'Customer One', phone: '9000000000', areaId: 'a1' }],
    borrowers: [{
      id: 'l1', customerId: 'c1', name: 'Customer One', areaId: 'a1',
      originalLoanAmount: 50000, loan: 42000, remainingPrincipal: 42000,
      openingPaidAmount: 1000, openingPaidDate: '2026-08-01', loanType: 'Monthly Interest',
      interestRate: 5, cycleAllocations: [{ cycleId: '2026-08', amount: 2500, paidAt: '2026-08-03' }]
    }],
    entryLog: [{
      id: 'p1', bid: 'l1', date: '2026-08-03', ts: '2026-08-03T10:00:00Z', today: 3000,
      principalComponent: 500, interestComponent: 2500, cashAmt: 1000, upiAmt: 2000,
      cycleId: '2026-08', cyclePeriodStart: '2026-08-01', cyclePeriodEnd: '2026-08-31',
      cycleAllocations: [{ cycleId: '2026-08', amount: 2500 }]
    }],
    areas: [{ id: 'a1', name: 'Area One', collectionDay: 'Monday' }],
    nonAccTxns: [], upiIds: [], expenses: [], tombstones: []
  };
}

const original = state();
const expected = C.financialIntegritySnapshot(original);
assert.deepStrictEqual(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(state())), [], 'unchanged critical content verifies');

const amountChanged = state(); amountChanged.entryLog[0].today = 2999;
assert.ok(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(amountChanged)).some(x => x.includes('entryLog.hash')), 'payment amount corruption is detected with unchanged ID');

const linkChanged = state(); linkChanged.entryLog[0].bid = 'other-loan';
assert.ok(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(linkChanged)).some(x => x.includes('entryLog.hash')), 'payment-to-loan linkage corruption is detected');

const cycleChanged = state(); cycleChanged.borrowers[0].cycleAllocations[0].amount = 2600;
assert.ok(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(cycleChanged)).some(x => x.includes('borrowers.hash')), 'cycle allocation corruption is detected');

const tenderChanged = state(); tenderChanged.entryLog[0].cashAmt = 1500; tenderChanged.entryLog[0].upiAmt = 1500;
assert.ok(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(tenderChanged)).some(x => x.includes('entryLog.hash')), 'cash and UPI split corruption is detected');

const timestampChanged = state(); timestampChanged.entryLog[0].ts = '2026-08-04T10:00:00Z';
assert.ok(C.compareFinancialIntegrity(expected, C.financialIntegritySnapshot(timestampChanged)).some(x => x.includes('entryLog.hash')), 'transaction timestamp corruption is detected');

const html = fs.readFileSync('www/index.html', 'utf8');
assert.ok(html.includes('financial:_vbFinancialIntegritySnapshot()'), 'standard backup exports content integrity metadata');
assert.ok(html.includes('financial:_vbFinancialIntegritySnapshot(_vbPayloadFinancialState(payload))'), 'read-only Drive backup derives content integrity metadata from the exact frozen payload');
assert.ok(html.includes('financial content integrity mismatch'), 'restore rejects changed critical content before commit');
assert.ok(html.includes('contentMismatches='), 'restore audit reports mismatch counts without raw values');
assert.ok(html.includes("Drive backup content preflight"), 'backup validates canonical financial content before upload');
assert.ok(html.includes("Drive backup post-build verification"), 'backup revalidates canonical financial content after preparation');

console.log(JSON.stringify({ status: 'PASS', checks: ['amount', 'loan-link', 'cycle-allocation', 'cash-upi-split', 'timestamp', 'pre-backup', 'pre-restore', 'post-restore-audit'] }, null, 2));
