'use strict';

// Regression test for: "Fix Interest Loan calculation logic" — Previous
// Interest Pending.
//
// Root cause (confirmed via the codebase's own existing diagnostic,
// _auditInterestPreviousPending, which explicitly flags exactly this gap
// as "legacyScalarFlags"/"settledCarryFlags"): a loan's saved
// b.prevPendingInterest — entered once at loan creation for arrears that
// already existed before the loan was tracked in this system — was NEVER
// folded into the cycle-based due calculation
// (_completedInterestCycles / _interestCycleAllocationProjection, which
// feed the canonical getInterestBreakdown -> getInterestCycleCalculation
// used everywhere: Card, Collect, Info, Receipt, History, Reports). The
// value sat on the borrower record but the actual Interest Due total
// silently ignored it.
//
// Fix: _previousPendingInterestCycle(b) derives a synthetic "cycle 0" from
// the saved prevPendingInterest amount (or null when it's ₹0/unset — zero
// impact, nothing added). It is prepended to the cycle array built by BOTH
// _completedInterestCycles (payment-allocation time) and
// _interestCycleAllocationProjection (display/due-calculation time), so it
// participates in the exact same "oldest debt first" free-payment
// allocation as a real overdue cycle would — recomputed fresh from the
// saved field and entryLog every call, so it can never duplicate and
// correctly settles to ₹0 permanently once paid off.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function buildContext(entryLog) {
  const dates = [
    ['2026-08-01', '2026-08-08'],
    ['2026-08-08', '2026-08-15'],
    ['2026-08-15', '2026-08-22'],
    ['2026-08-22', '2026-08-29'],
    ['2026-08-29', '2026-09-05'],
    ['2026-09-05', '2026-09-12'], // cycle 6 — not yet completed by COMPLETED_REF, exists only so _completedInterestCycles' one-ahead probe doesn't read past the array
  ];
  const context = {
    console, Math, Object, Array, String, Number, isFinite, parseFloat, parseInt,
    entryLog: entryLog || [],
    todayStr: () => '2026-09-01',
    _cycleIndexAt: () => 5,
    _nthCycleStart: (_b, idx) => dates[idx - 1][0],
    _nthCycleEnd: (_b, idx) => dates[idx - 1][1],
    _periodInterestGross: () => 1000, // each real weekly cycle accrues ₹1,000
    _interestEntriesChrono: (borrower, refDate) => context.entryLog
      .filter(e => e.bid === borrower.id && e.date <= refDate)
      .sort((a, b) => `${a.date}|${a.id}`.localeCompare(`${b.date}|${b.id}`)),
  };
  vm.createContext(context);
  ['_previousPendingInterestCycle', '_completedInterestCycles', '_interestCycleAllocationProjection', '_allocateInterestToCompletedCycles']
    .forEach(name => vm.runInContext(extractFunction(name), context));
  return context;
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// ── 1. _previousPendingInterestCycle: ₹0/unset → null (zero impact). ───────
{
  const ctx = buildContext([]);
  check('₹0 prevPendingInterest -> null (add exactly nothing)', ctx._previousPendingInterestCycle({ prevPendingInterest: 0, loandate: '2026-07-01' }) === null);
  check('unset prevPendingInterest -> null', ctx._previousPendingInterestCycle({ loandate: '2026-07-01' }) === null);
  check('negative prevPendingInterest -> null (never a negative synthetic cycle)', ctx._previousPendingInterestCycle({ prevPendingInterest: -50, loandate: '2026-07-01' }) === null);
  const seed = ctx._previousPendingInterestCycle({ prevPendingInterest: 800, loandate: '2026-07-01' });
  check('positive prevPendingInterest -> a synthetic cycle with the FULL saved amount as gross', seed && seed.gross === 800, JSON.stringify(seed));
  check('synthetic cycle uses idx 0 (never collides with real cycle 1..N)', seed.idx === 0);
}

// Reference date for the "completed cycles" tests below: cycle 5 (the last
// of the 5 fixture cycles) ends 2026-09-05, so a ref of 2026-09-05 is
// required for all 5 to count as completed (_completedInterestCycles
// correctly excludes any cycle whose end is still in the future).
const COMPLETED_REF = '2026-09-05';

// ── 2. _completedInterestCycles: zero case is byte-for-byte unaffected. ────
{
  const ctxZero = buildContext([]);
  const bZero = { id: 'B1', prevPendingInterest: 0, loandate: '2026-08-01', interestCalcStart: '' };
  const cyclesZero = ctxZero._completedInterestCycles(bZero, COMPLETED_REF);
  check('zero prevPendingInterest: first cycle is still idx 1 (no seed inserted)', cyclesZero[0].idx === 1, JSON.stringify(cyclesZero[0]));
  check('zero prevPendingInterest: exactly 5 real completed cycles, nothing extra', cyclesZero.length === 5, 'len=' + cyclesZero.length);
}
{
  const ctx = buildContext([]);
  const b = { id: 'B2', prevPendingInterest: 800, loandate: '2026-08-01', interestCalcStart: '' };
  const cycles = ctx._completedInterestCycles(b, COMPLETED_REF);
  check('non-zero prevPendingInterest: seed is prepended as the very first entry', cycles[0].idx === 0 && cycles[0].gross === 800);
  check('non-zero prevPendingInterest: the 5 real cycles still follow, unchanged', cycles.length === 6 && cycles[1].idx === 1);
}

// ── 3. Total Interest Due = Previous Interest Pending + applicable
//      completed-cycle Interest Due (via _allocateInterestToCompletedCycles,
//      the actual payment-allocation-time aggregator). ────────────────────
{
  const ctx = buildContext([]); // brand new loan, no payments made yet
  const b = { id: 'B3', prevPendingInterest: 800, loandate: '2026-08-01', interestCalcStart: '' };
  const alloc = ctx._allocateInterestToCompletedCycles(b, COMPLETED_REF);
  // 5 real completed cycles x ₹1,000 gross = ₹5,000, plus the full ₹800 previous pending.
  check('brand-new loan: full previous pending (₹800) is included in total pending', alloc.pending === 5800, 'pending=' + alloc.pending);
}

// ── 4. A payment made now (free/unallocated cash) settles the OLDEST debt
//      first — the previous pending interest — exactly like a real overdue
//      cycle would, never skipped. ──────────────────────────────────────────
{
  const entryLog = [{ id: 'E1', bid: 'B4', date: COMPLETED_REF, interestComponent: 500 }]; // partial payment
  const ctx = buildContext(entryLog);
  const b = { id: 'B4', prevPendingInterest: 800, loandate: '2026-08-01', interestCalcStart: '' };
  const alloc = ctx._allocateInterestToCompletedCycles(b, COMPLETED_REF);
  const seedCycle = alloc.cycles.find(c => c.idx === 0);
  check('a partial free payment (₹500) is applied to the previous-pending cycle first', seedCycle.paid === 500 && seedCycle.pending === 300, JSON.stringify(seedCycle));
  check('total pending correctly reduced by exactly the payment amount: 5800 - 500 = 5300', alloc.pending === 5300, 'pending=' + alloc.pending);
}

// ── 5. Once fully paid, the previous pending interest settles to ₹0 and
//      STAYS ₹0 on every subsequent recalculation — never regenerated,
//      never duplicated. ────────────────────────────────────────────────────
{
  const entryLog = [{ id: 'E1', bid: 'B5', date: COMPLETED_REF, interestComponent: 800 }]; // exactly covers it
  const ctx = buildContext(entryLog);
  const b = { id: 'B5', prevPendingInterest: 800, loandate: '2026-08-01', interestCalcStart: '' };
  const alloc1 = ctx._allocateInterestToCompletedCycles(b, COMPLETED_REF);
  const seed1 = alloc1.cycles.find(c => c.idx === 0);
  check('fully-covering payment settles previous pending to exactly ₹0', seed1.pending === 0, JSON.stringify(seed1));
  // Recompute again (simulating a refresh/restart) — must remain settled, not resurrected.
  const alloc2 = ctx._allocateInterestToCompletedCycles(b, COMPLETED_REF);
  const seed2 = alloc2.cycles.find(c => c.idx === 0);
  check('re-running the calculation later never resurrects a settled previous pending amount', seed2.pending === 0, JSON.stringify(seed2));
  check('the excess beyond the seed correctly flows to real cycles, nothing lost or double-counted', alloc1.pending === 5000, 'pending=' + alloc1.pending);
}

// ── 6. _interestCycleAllocationProjection (display/due-calc path, the one
//      getInterestBreakdown actually calls) shows the same behavior. ───────
{
  const ctx = buildContext([]);
  const b = { id: 'B6', prevPendingInterest: 800, loandate: '2026-08-01', interestCalcStart: '' };
  const projection = ctx._interestCycleAllocationProjection(b, 0, '2026-09-01');
  const seed = projection.cycles.find(c => c.idx === 0);
  check('display/due-calculation projection also includes the full previous pending amount', seed && seed.gross === 800 && seed.pending === 800);
  check('display projection total pending = previous pending + completed cycles: 800 + 5000 = 5800', projection.pending === 5800, 'pending=' + projection.pending);
}
{
  // Zero case: the display projection is byte-for-byte identical to before this fix.
  const ctxZero = buildContext([]);
  const bZero = { id: 'B7', prevPendingInterest: 0, loandate: '2026-08-01', interestCalcStart: '' };
  const projectionZero = ctxZero._interestCycleAllocationProjection(bZero, 0, '2026-09-01');
  check('zero prevPendingInterest: display projection unaffected — pending is purely the 5 real cycles (₹5,000)', projectionZero.pending === 5000, 'pending=' + projectionZero.pending);
  check('zero prevPendingInterest: no idx:0 entry appears in the projection at all', !projectionZero.cycles.some(c => c.idx === 0));
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  status: failed.length ? 'FAIL' : 'PASS',
  checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  failures: failed,
}, null, 2));
if (failed.length) process.exitCode = 1;
