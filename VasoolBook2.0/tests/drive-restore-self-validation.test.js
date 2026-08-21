'use strict';

// Verifies the isolated Daily-Full restore preflight self-validation added to fix the
// recurring "customers/borrowers/entryLog mismatch" restore bug:
//   - validation is computed ONLY from the exact downloaded/decrypted backup package
//     (never from live local customers/borrowers/entryLog — the vm sandbox below never
//     defines those globals, so any accidental reference throws ReferenceError)
//   - a mismatch reports backup ID/revision, store name, expected/actual count+hash,
//     and first differing record IDs (not a generic error)
//   - stale/mixed manifest+snapshot pairs and corrupt/incomplete uploads are detected
//   - automatic fallback to the previous Daily Full backup requires explicit confirmation
//   - only after self-validation PASSES does the caller proceed to apply/migrate
//   - a post-restore hash check compares the freshly-committed local state back against
//     the validated backup

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('www/index.html', 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, name + ' must exist');
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0;
  let quote = '';
  let escaped = false;
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
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }

// ── fixtures: two "Daily Full" backup packages, sealed/opened via stubs (no real network
// or WebCrypto — those are I/O boundaries, not the business logic under test) ───────────
function buildPayload(entryToday) {
  return {
    app: 'VasoolBook',
    customers: [{ id: 'c1', name: 'Alice' }],
    loanProfiles: [{ id: 'loan-1', borrowerId: 'c1', loan: 1000 }],
    entryLog: [{ id: 'pay-1', loanId: 'loan-1', today: entryToday, createdAt: '2026-08-10T00:00:00.000Z' }],
    areas: [], nonAccTxns: [], upiIds: [], expenses: [], reminders: [], collReports: [],
    settings: {}, cashbook: {}, retiredAreaIds: {}, legacyRecords: {}
  };
}

const MANIFEST_VERSION = 2;

const context = {
  JSON, Object, Array, String, Number, Math, Error, DOMException, Promise,
  _GD_RECORD_MANIFEST_VERSION: MANIFEST_VERSION,
  _GD_INC_MANIFEST_NAME: 'VasoolBook_Incremental_Manifest_v2.json',
  _gdRestoreRecordKey(kind, row) { if (row && row.id != null) return 'id:' + String(row.id); return ''; },
  _gdStringChecksum(text) {
    text = String(text || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); }
    return (h >>> 0).toString(16);
  },
  _gdSha256: async text => sha256(text),
  _gdVerifyBackupData(data) { if (!data || data.app !== 'VasoolBook') throw new Error('not a VasoolBook backup'); return 1; },
  _gdCalculatePayloadSha256: async () => '', // test payloads carry no backupMetadata.sha256, so this branch is inert
  _gdProgress() {},
  _storageAudit(...args) { context._auditLog.push(args); },
  _auditLog: [],
  // network/download stubs — keyed fixtures set per test
  _downloads: {}, // id -> sealedText
  _opens: {},     // sealedText -> { text } | 'throw'
  _gdDownloadTextById: async id => {
    if (!(id in context._downloads)) throw new Error('unexpected download id ' + id);
    return context._downloads[id];
  },
  _gdOpenBackupText: async (sealedText) => {
    const rule = context._opens[sealedText];
    if (!rule) throw new Error('unexpected sealed text');
    if (rule === 'throw') throw new Error('decryption failed');
    return { text: rule.text, envelope: { plainSha256: sha256(rule.text) } };
  },
  // fallback-confirmation UI stub — records every prompt so tests can assert the user
  // was actually asked before restoring an older revision
  _confirmCalls: [],
  _confirmResolution: true,
  _gdShowRestoreFallbackConfirm: async (failedFile, errorMessage, fallbackFile) => {
    context._confirmCalls.push({ failedFile, errorMessage, fallbackFile });
    return context._confirmResolution;
  },
  _fullsList: [],
  _gdListDailyFullBackups: async () => context._fullsList,
  // restore-time collaborators exercised only when increments are non-empty (kept as
  // throwing stubs so an accidental increment-application path fails loudly in tests)
  _gdApplyIncrementalDelta: () => { throw new Error('increments not expected in this test'); },
  _gdYield: async () => {},
  _vbNormalizeBackupPayload: data => data,
  _gdPrepareEnterprisePayload: async data => ({ text: JSON.stringify(data), data, size: JSON.stringify(data).length }),
  _localPayload: null,
  _gdBuildReadOnlyFullPayload: () => context._localPayload,
  // _gdMaterializeIncrementalRestore always calls _gdLoadIncrementalManifest() itself
  // (production code loads the central manifest fresh); tests point this at a fixture.
  _manifestStub: null,
  _gdLoadIncrementalManifest: async () => context._manifestStub
};
vm.createContext(context);
[
  '_gdIncrementalCollections', '_gdCanonicalRecordValue', '_gdCanonicalRecordText', '_gdIncrementalKey',
  '_gdRecordManifest', '_gdRecordManifestCanonical', '_gdStateChecksum', '_gdRecordManifestDifferences',
  '_gdRecordManifestMismatchError', '_gdDailyFullLabel', '_gdSelfValidateDailyFull',
  '_gdRestorePreflightSelfValidate', '_gdMaterializeIncrementalRestore', '_gdPostRestoreSelfVerify'
].forEach(name => vm.runInContext(functionSource(name), context));

function seal(fileId, payload) {
  const text = JSON.stringify(payload);
  const sealedText = 'SEALED[' + fileId + ']';
  context._downloads[fileId] = sealedText;
  context._opens[sealedText] = { text };
  return { cipherSha256: sha256(sealedText), plainSha256: sha256(text) };
}

(async () => {
  const results = [];
  function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

  // ── Fixture: build "full-1" (older, previously valid) and "full-2" (latest, mutated) ──
  const goodPayload = buildPayload(100);
  const goodPlan = context._gdRecordManifest(goodPayload, {}, MANIFEST_VERSION);
  const goodState = await context._gdStateChecksum(goodPlan.records, MANIFEST_VERSION);
  goodPayload.driveSelfManifest = { version: MANIFEST_VERSION, stateChecksum: goodState, records: goodPlan.records };
  const goodChecksums = seal('full-1', goodPayload);
  const fullOne = { id: 'full-1', name: 'VasoolBook_Full_20260810.vbi', createdTime: '2026-08-10T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: goodChecksums.cipherSha256, vbPlainSha256: goodChecksums.plainSha256 } };

  // full-2: financial mutation (pay-1.today 100 -> 999) but its OWN embedded manifest was
  // computed from the ORIGINAL data — i.e. the embedded manifest and the actual snapshot
  // bytes disagree, exactly the "customers/borrowers/entryLog preflight mismatch" bug.
  const mutatedPayload = buildPayload(999);
  mutatedPayload.driveSelfManifest = { version: MANIFEST_VERSION, stateChecksum: goodState, records: goodPlan.records };
  const mutatedChecksums = seal('full-2', mutatedPayload);
  const fullTwoMutated = { id: 'full-2', name: 'VasoolBook_Full_20260817.vbi', createdTime: '2026-08-17T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: mutatedChecksums.cipherSha256, vbPlainSha256: mutatedChecksums.plainSha256 } };

  // 1. Isolated self-validation of a clean backup passes and never touches "local" state
  //    (the sandbox defines no customers/borrowers/entryLog globals at all).
  {
    const result = await context._gdSelfValidateDailyFull(fullOne);
    check('clean Daily Full self-validates in isolation', result.stateChecksum === goodState);
  }

  // 2. A mutated snapshot vs its own embedded manifest fails with exact diagnostics:
  //    backup id, store name, expected/actual hash, first differing record id.
  {
    let threw = null;
    try { await context._gdSelfValidateDailyFull(fullTwoMutated); } catch (e) { threw = e; }
    check('embedded-manifest mismatch is detected (not a generic error)',
      !!threw && /entryLog/.test(threw.message) && /id:pay-1/.test(threw.message) && /expectedHash=/.test(threw.message) && /actualHash=/.test(threw.message),
      threw && threw.message);
  }

  // 3. Corrupt/incomplete upload (Drive-stored cipher checksum does not match the
  //    downloaded bytes) is detected and reported by name/revision.
  {
    const corruptId = 'full-3';
    context._downloads[corruptId] = 'GARBLED-BYTES';
    const fullThree = { id: corruptId, name: 'VasoolBook_Full_bad.vbi', createdTime: '2026-08-18T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: 'deadbeef', vbPlainSha256: 'deadbeef' } };
    let threw = null;
    try { await context._gdSelfValidateDailyFull(fullThree); } catch (e) { threw = e; }
    check('incomplete/corrupt upload detected via Drive-stored cipher checksum',
      !!threw && /incomplete or corrupt upload/i.test(threw.message) && threw.message.indexOf(corruptId) >= 0, threw && threw.message);
  }

  // 4. Stale/mixed manifest+snapshot pair: decrypts fine, but the Drive-stored plaintext
  //    checksum does not match what was actually decrypted.
  {
    const staleId = 'full-4';
    const staleText = JSON.stringify(buildPayload(1));
    context._downloads[staleId] = 'SEALED[full-4]';
    context._opens['SEALED[full-4]'] = { text: staleText };
    const fullFour = { id: staleId, name: 'VasoolBook_Full_stale.vbi', createdTime: '2026-08-18T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: sha256('SEALED[full-4]'), vbPlainSha256: 'not-the-real-hash' } };
    let threw = null;
    try { await context._gdSelfValidateDailyFull(fullFour); } catch (e) { threw = e; }
    check('stale/mixed manifest+snapshot pair detected', !!threw && /stale or mixed manifest\/snapshot pair/i.test(threw.message), threw && threw.message);
  }

  // 5. Preflight orchestration: latest fails self-validation -> user is explicitly asked
  //    -> confirms -> previous Daily Full is used instead. No local/empty-state comparison
  //    anywhere in this path (isolation re-asserted: same customers/borrowers/entryLog-free
  //    sandbox).
  {
    context._fullsList = [fullTwoMutated, fullOne];
    context._confirmCalls.length = 0;
    context._confirmResolution = true;
    const manifest = { baseFull: { id: 'full-2', stateChecksum: goodState }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    const validated = await context._gdRestorePreflightSelfValidate({ manifest });
    check('fallback used previous Daily Full only after explicit confirmation',
      validated && validated.usedFallback === true && validated.fileRef.id === 'full-1' && context._confirmCalls.length === 1
      && context._confirmCalls[0].failedFile.id === 'full-2' && context._confirmCalls[0].fallbackFile.id === 'full-1',
      JSON.stringify({ validated: validated && { id: validated.fileRef.id, usedFallback: validated.usedFallback }, confirmCalls: context._confirmCalls.length }));
  }

  // 6. If the user declines the fallback, restore is cancelled (never silently restores
  //    an older revision without consent) and local data is untouched.
  {
    context._fullsList = [fullTwoMutated, fullOne];
    context._confirmCalls.length = 0;
    context._confirmResolution = false;
    const manifest = { baseFull: { id: 'full-2', stateChecksum: goodState }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    let threw = null;
    try { await context._gdRestorePreflightSelfValidate({ manifest }); } catch (e) { threw = e; }
    check('declining the fallback cancels restore instead of silently proceeding',
      !!threw && threw.name === 'AbortError' && /declined/i.test(threw.message), threw && threw.message);
  }

  // 7. If every available Daily Full fails self-validation, the combined error names all
  //    attempted backup IDs (never a generic "restore failed").
  {
    const alsoMutated = JSON.parse(JSON.stringify(mutatedPayload));
    const alsoMutatedChecksums = seal('full-5', alsoMutated);
    const fullFive = { id: 'full-5', name: 'VasoolBook_Full_alsobad.vbi', createdTime: '2026-08-05T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: alsoMutatedChecksums.cipherSha256, vbPlainSha256: alsoMutatedChecksums.plainSha256 } };
    context._fullsList = [fullTwoMutated, fullFive];
    context._confirmCalls.length = 0;
    context._confirmResolution = true;
    const manifest = { baseFull: { id: 'full-2', stateChecksum: goodState }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    let threw = null;
    try { await context._gdRestorePreflightSelfValidate({ manifest }); } catch (e) { threw = e; }
    check('all-backups-failed reports every attempted backup id',
      !!threw && threw.message.indexOf('full-2') >= 0 && threw.message.indexOf('full-5') >= 0, threw && threw.message);
  }

  // 8. End-to-end: fresh empty app -> latest Daily Full restore (no fallback needed).
  {
    context._fullsList = [fullOne];
    context._manifestStub = { baseFull: { id: 'full-1', stateChecksum: goodState }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    const restored = await context._gdMaterializeIncrementalRestore({});
    check('fresh empty app restores the latest Daily Full with zero incremental replay',
      restored && restored.selfValidation.usedFallback === false && restored.selfValidation.appliedIncrements === 0 && restored.selfValidation.stateChecksum === goodState,
      restored && JSON.stringify(restored.selfValidation));

    // 9. Restart (simulated by a second independent call) reproduces the identical result.
    const restoredAgain = await context._gdMaterializeIncrementalRestore({});
    check('restart reproduces an identical validated result', restoredAgain.selfValidation.stateChecksum === restored.selfValidation.stateChecksum);

    // 10. Post-restore hash equality against the now-committed local data.
    context._localPayload = goodPayload;
    const postVerify = await context._gdPostRestoreSelfVerify(restored.selfValidation, { borrowers: 0, payments: 0 });
    check('post-restore hash equals the restored backup exactly on a fresh app', postVerify.checked && postVerify.matches === true, JSON.stringify(postVerify));

    // 11. Backup again: recomputing the manifest from that same local data is stable and
    //     reproduces the identical checksum (canonical hashing is deterministic).
    const rebackupPlan = context._gdRecordManifest(context._localPayload, {}, MANIFEST_VERSION);
    const rebackupState = await context._gdStateChecksum(rebackupPlan.records, MANIFEST_VERSION);
    check('backing up again reproduces the identical checksum', rebackupState === goodState);
  }

  // 12. Fallback restore skips incremental replay it can no longer trust (increments were
  //     chained from the failed latest full, not from the fallback), and says so explicitly.
  {
    context._fullsList = [fullTwoMutated, fullOne];
    context._confirmCalls.length = 0;
    context._confirmResolution = true;
    context._manifestStub = { baseFull: { id: 'full-2', stateChecksum: goodState }, increments: [{ id: 'inc-1', sequence: 1, cipherSha256: 'x' }], stateChecksum: 'irrelevant', keyId: 'k1' };
    const restored = await context._gdMaterializeIncrementalRestore({});
    check('fallback restore skips incremental replay and reports why',
      restored.selfValidation.usedFallback === true && restored.selfValidation.appliedIncrements === 0 && /NOT applied/.test(restored.selfValidation.note),
      JSON.stringify(restored.selfValidation));
  }

  // 12b. Legacy backup: driveSelfManifest exists but predates explicit version tagging.
  //      Its stateChecksum was computed under whatever rules that older build used and
  //      cannot be safely reproduced today — comparing it against a freshly-recomputed
  //      state under the CURRENT manifest version must never throw (that is exactly the
  //      recurring "customers/borrowers/entryLog mismatch" bug: real, expected migration
  //      growth mistaken for corruption). Structural checks (_gdVerifyBackupData) still run.
  {
    const legacyId = 'full-legacy-1';
    const legacyPayload = buildPayload(250);
    const legacyPlan = context._gdRecordManifest(legacyPayload, {}, 1); // computed under an OLD algorithm
    const legacyState = await context._gdStateChecksum(legacyPlan.records, 1);
    legacyPayload.driveSelfManifest = { stateChecksum: legacyState, records: legacyPlan.records }; // no .version field
    const legacyChecksums = seal(legacyId, legacyPayload);
    const fullLegacy = { id: legacyId, name: 'VasoolBook_Full_2022.vbi', createdTime: '2022-03-01T00:00:00.000Z', appProperties: { vbType: 'full', vbKeyId: 'k1', vbCipherSha256: legacyChecksums.cipherSha256, vbPlainSha256: legacyChecksums.plainSha256 } };
    const legacyResult = await context._gdSelfValidateDailyFull(fullLegacy);
    check('legacy self-manifest without a declared version never blocks self-validation',
      legacyResult.legacyManifest === true && legacyResult.stateChecksum !== legacyState,
      JSON.stringify({ legacyManifest: legacyResult.legacyManifest, recomputed: legacyResult.stateChecksum, embedded: legacyState }));
  }

  // 12c. A CURRENT-version self-manifest that genuinely mismatches must still block exactly
  //      as before — the legacy relaxation must never weaken detection of real corruption
  //      in an up-to-date backup (already covered by check #2, re-asserted here for the
  //      legacyManifest flag specifically).
  {
    let threw = null;
    try { await context._gdSelfValidateDailyFull(fullTwoMutated); } catch (e) { threw = e; }
    check('a current-format mismatch is still rejected (legacy relaxation is scoped, not global)', !!threw, threw && threw.message);
  }

  // 12d. Central-manifest cross-check: a baseFull entry recorded under an OLDER
  //      recordManifestVersion than the daily-full's own (current) self-validation result
  //      must not be strictly compared — same version-aware guard, applied to the
  //      manifest-vs-daily-full cross-check inside _gdRestorePreflightSelfValidate.
  {
    context._fullsList = [fullOne];
    context._confirmCalls.length = 0;
    // baseFull claims a stale/incompatible version (1) and a checksum that would NOT match
    // fullOne's current (version 2) recomputed state — under the old code this threw a
    // "stale/mixed manifest+snapshot pair" error for every legacy account; it must not now.
    const manifest = { baseFull: { id: 'full-1', stateChecksum: 'stale-checksum-from-old-algorithm', recordManifestVersion: 1 }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    const validated = await context._gdRestorePreflightSelfValidate({ manifest });
    check('central-manifest cross-check is skipped when the baseFull entry predates the current record-manifest version',
      validated && validated.fileRef.id === 'full-1' && validated.usedFallback === false && context._confirmCalls.length === 0,
      JSON.stringify(validated && { id: validated.fileRef.id, usedFallback: validated.usedFallback }));
  }

  // 12e. Same-version cross-check still protects a genuinely stale/mixed manifest+snapshot
  //      pair — the version-aware gate must not blanket-disable this check.
  {
    context._fullsList = [fullOne];
    context._confirmCalls.length = 0;
    context._confirmResolution = true;
    const manifest = { baseFull: { id: 'full-1', stateChecksum: 'wrong-checksum-same-version', recordManifestVersion: MANIFEST_VERSION }, increments: [], stateChecksum: goodState, keyId: 'k1' };
    let threw = null;
    try { await context._gdRestorePreflightSelfValidate({ manifest }); } catch (e) { threw = e; }
    check('same-version central-manifest mismatch is still detected (protection preserved for aligned versions)',
      !!threw && /stale\/mixed manifest\+snapshot pair/i.test(threw.message), threw && threw.message);
  }

  // 13. Backup creation embeds the self-contained manifest before sealing (source check).
  // This delta-building logic lives in _gdBuildIncrementalDelta (extracted out of
  // _gdIncrementalBackupImpl by the sync-conflict rebase-and-retry fix, so it can be
  // re-run against a freshly-observed manifest without re-running the whole upload flow).
  {
    const backupFn = functionSource('_gdBuildIncrementalDelta');
    const embedPos = backupFn.indexOf('driveSelfManifest');
    const sealPos = backupFn.indexOf('_gdSealBackupText(plainText,key,kind)');
    check('Daily Full backups embed their own record manifest before sealing', embedPos >= 0 && embedPos < sealPos);
  }

  // 14. Self-validation runs before any migration/normalization (ordering invariant).
  {
    const restoreFn = functionSource('_gdMaterializeIncrementalRestore');
    const validatePos = restoreFn.indexOf('_gdRestorePreflightSelfValidate(');
    const migratePos = restoreFn.indexOf('payload=_vbNormalizeBackupPayload(payload)');
    check('self-validation completes before migration/normalization', validatePos >= 0 && migratePos > validatePos);
    const selfValidateFn = functionSource('_gdSelfValidateDailyFull');
    check('self-validation never normalizes/migrates the snapshot it is checking', selfValidateFn.indexOf('_vbNormalizeBackupPayload') === -1);
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    checks: results.map(r => ({ name: r.name, ok: r.ok })),
    failures: failed
  }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
