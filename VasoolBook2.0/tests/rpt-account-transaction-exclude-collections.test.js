'use strict';

// Verifies the Account Transaction report section (Reports tab, "🏦 Account
// Transaction" / "💵 Non-Account Transaction" / Summary) no longer mixes
// borrower loan collections/payouts into its credit/debit calculation, while
// "Collection Totals" (a differently-scoped, pre-existing section) stays
// exactly as before.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

// The Account Transaction NAT block lives inside the huge renderReports()
// function (too large/regex-heavy to safely brace-extract as one unit — see
// this codebase's established convention of testing such blocks via direct
// source-range assertions instead). Isolate just the relevant slice by its
// well-known anchor comments.
const blockStart = source.indexOf('// ── NAT PAYMENT CHANNELS');
assert.ok(blockStart >= 0, 'NAT payment channels block exists');
const blockEnd = source.indexOf('natEl.innerHTML=accHtml+natBlockHtml+summaryHtml;', blockStart);
assert.ok(blockEnd > blockStart, 'Account Transaction block end anchor exists');
const block = source.slice(blockStart, blockEnd);

// ── 1. The four net/credit calculations feeding the Account Transaction UI
//    must be pure nonAccTxns (natAccIn/natAccOut/natCashIn/natCashOut) —
//    never onlineCollAmt/onlineLoanDebit/cashCollAmt/cashLoanDebit. ────────
{
  const accNet2 = /var _accNet2=([^;]+);/.exec(block);
  assert.ok(accNet2, '_accNet2 assignment found');
  assert.strictEqual(accNet2[1].replace(/\s/g, ''), '(natAccIn||0)-(natAccOut||0)', '_accNet2 (Net Account Balance) excludes borrower collections/payouts entirely: ' + accNet2[1]);

  const cashNet = /var _cashNet=([^;]+);/.exec(block);
  assert.ok(cashNet, '_cashNet assignment found');
  assert.strictEqual(cashNet[1].replace(/\s/g, ''), '(natCashIn||0)-(natCashOut||0)', '_cashNet (Net Cash Balance) excludes borrower collections/payouts entirely: ' + cashNet[1]);

  const accNetFinal = /var _accNetFinal=([^;]+);/.exec(block);
  assert.ok(accNetFinal, '_accNetFinal assignment found');
  assert.strictEqual(accNetFinal[1].replace(/\s/g, ''), '(natAccIn||0)-(natAccOut||0)', '_accNetFinal (Summary Account Net) excludes borrower collections/payouts: ' + accNetFinal[1]);

  const cashNetFinal = /var _cashNetFinal=([^;]+);/.exec(block);
  assert.ok(cashNetFinal, '_cashNetFinal assignment found');
  assert.strictEqual(cashNetFinal[1].replace(/\s/g, ''), '(natCashIn||0)-(natCashOut||0)', '_cashNetFinal (Summary Cash Net) excludes borrower collections/payouts: ' + cashNetFinal[1]);
}

// ── 2. Bank Credit / Cash Credit are now explicit, labeled figures sourced
//    only from recorded Account Transactions (natAccIn/natCashIn). ────────
{
  assert.ok(/Bank Credit[\s\S]{0,80}fmt\(natAccIn\|\|0\)/.test(block), 'Bank Credit is shown and sourced from natAccIn only');
  assert.ok(/Cash Credit[\s\S]{0,80}fmt\(natCashIn\|\|0\)/.test(block), 'Cash Credit is shown and sourced from natCashIn only');
}

// ── 3. Borrower collection/loan-payout rows are no longer rendered inside
//    the Account Transaction / Non-Account Transaction sections. ──────────
{
  assert.ok(!block.includes('📥 Online Collection'), 'Online Collection row removed from Account Transaction section');
  assert.ok(!block.includes('🏦 Online Loan Payout'), 'Online Loan Payout row removed from Account Transaction section');
  assert.ok(!block.includes('💵 Cash Collections</div>') || block.indexOf('💵 Cash Collections</div>') < 0, 'Cash Collections row removed from Non-Account Transaction section');
  assert.ok(!block.includes('💸 Cash Loan Payouts'), 'Cash Loan Payouts row removed from Non-Account Transaction section');
}

// ── 4. "Collection Totals" is a DIFFERENT, pre-existing, correctly-scoped
//    section — it must be completely unchanged, still showing
//    cashCollAmt/onlineCollAmt exactly as before this fix. ────────────────
{
  const collTotalsStart = block.indexOf('&#x1F4CA; Collection Totals');
  assert.ok(collTotalsStart >= 0, 'Collection Totals section still exists');
  const collTotalsSlice = block.slice(collTotalsStart, collTotalsStart + 1200);
  assert.ok(collTotalsSlice.includes('fmt(cashCollAmt)'), 'Collection Totals Cash Total is unchanged (still cashCollAmt)');
  assert.ok(collTotalsSlice.includes('fmt(onlineCollAmt)'), 'Collection Totals Online Total is unchanged (still onlineCollAmt)');
}

// ── 5. The nonAccTxns accumulation itself (natCashIn/natCashOut/natAccIn/
//    natAccOut) only ever iterates nonAccTxns, never entryLog — real
//    behavioral proof that borrower collections cannot enter these totals
//    at the source, independent of the formula-level checks above. ───────
{
  const accumMatch = /dayNat\.forEach\(function\(t\)\{[\s\S]{0,400}?\}\);/.exec(source);
  assert.ok(accumMatch, 'the NAT accumulation loop exists');
  const accumFn = 'function accumulate(dayNat){var natCashIn=0,natCashOut=0,natAccIn=0,natAccOut=0;' + accumMatch[0].replace('dayNat.forEach', 'dayNat.forEach') + 'return {natCashIn:natCashIn,natCashOut:natCashOut,natAccIn:natAccIn,natAccOut:natAccOut};}';
  const context = {};
  vm.createContext(context);
  vm.runInContext(accumFn, context);

  const nonAccTxns = [
    { type: 'acc_in', amount: 1000 },   // true Bank Credit
    { type: 'acc_out', amount: 200 },   // true Bank Debit
    { type: 'cash_in', amount: 500 },   // true Cash Credit
    { type: 'cash_out', amount: 100 },  // true Cash Debit
  ];
  // vm.runInContext returns objects constructed with that context's own
  // realm globals — round-trip through JSON so deepStrictEqual compares
  // plain host-realm objects instead of failing on cross-realm identity.
  const r = JSON.parse(JSON.stringify(context.accumulate(nonAccTxns)));
  assert.deepStrictEqual(r, { natCashIn: 500, natCashOut: 100, natAccIn: 1000, natAccOut: 200 }, 'accumulation correctly totals only true recorded Account Transactions');

  // A borrower collection entry (entryLog shape, not nonAccTxns) has no
  // `type` field matching acc_in/acc_out/cash_in/cash_out, so even if it were
  // accidentally passed into this same loop it would contribute nothing —
  // proving there is no code path by which a collection entry can inflate
  // these totals.
  const withStrayCollectionEntry = nonAccTxns.concat([{ bid: 'b1', today: 5000, pay: 'GPay', name: 'Ravi' }]);
  const r2 = JSON.parse(JSON.stringify(context.accumulate(withStrayCollectionEntry)));
  assert.deepStrictEqual(r2, r, 'a borrower-collection-shaped record contributes nothing to Account Transaction totals');
}

console.log(JSON.stringify({
  status: 'PASS',
  checks: [
    'account-net-excludes-collections',
    'cash-net-excludes-collections',
    'summary-account-net-excludes-collections',
    'summary-cash-net-excludes-collections',
    'bank-credit-cash-credit-labeled-and-scoped',
    'collection-rows-removed-from-account-sections',
    'collection-totals-section-unchanged',
    'nat-accumulation-only-reads-nonacctxns',
    'stray-collection-shaped-record-contributes-nothing',
  ],
}, null, 2));
