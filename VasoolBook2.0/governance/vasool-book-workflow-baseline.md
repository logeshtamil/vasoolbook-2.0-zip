# Vasool Book Workflow Baseline

## Local JSON Export

- Opening Paid preflight completes before an export snapshot is captured.
- Local JSON Export and Google Drive Backup use `_gdBeginImmutableBackupSnapshot` and `_gdEndImmutableBackupSnapshot` as one shared mutation fence.
- Build, proof, SHA-256, validation, serialization, and file output use the same frozen payload and data revision.
- Android export writes to `Downloads/VasoolBook`, reads the saved file back, and verifies byte count plus SHA-256 before reporting success.
- Browser File System Access export verifies the closed file before reporting success. A legacy browser download dispatch is not recorded as a successful export because completion is not observable.
- `Last Export`, filename/message, size, revision, and checksum update only after validation and verified write completion.
- Export failure preserves previous successful metadata and records an exact separate `Export Failed` attempt message.
- Legitimate live changes after snapshot capture remain local and are marked pending for the next export; the frozen payload is never mutated.

Evidence: `tests/local-json-export-immutable.test.js`, `tests/google-drive-frozen-snapshot.test.js`, and Android `compileDebugJavaWithJavac --offline`.

## Borrower Info Payment Delete

- The Delete button identifies the payment by borrower ID, payment ID, and its exact rendered `entryLog` index.
- Only the selected row is removed; another borrower payment with the same legacy ID is preserved.
- Opening Paid transactions remain protected and cannot be deleted.
- A timestamped tombstone is created before removal so stale IndexedDB data cannot resurrect the payment.
- Borrower balance, interest cycles, History, borrower cards, Collect state, reports, cash totals, due center, and receipt state refresh from the remaining ledger.
- The updated borrower, payment ledger, and tombstone commit atomically to IndexedDB before success is shown.
- A failed durable commit restores the complete pre-delete state and reports failure without a partial UI refresh.

Evidence: `tests/info-payment-delete.test.js`, `tests/local-recovery.test.js`, `tests/interest-cache-invalidation.test.js`, and `tests/rbac-financial-actions.test.js`.

## Weekly Interest Borrower Card Due Summary

- The borrower card reads the completed-cycle `interestLoanCycleDueSnapshot` only.
- With no prior or partial arrear, it shows one `Due Amount` for the completed current cycle.
- With an arrear, it shows one combined `Total Due`; it does not expose separate Previous Pending, Current Due, or calculation rows on the card.
- Info and Collect retain the detailed canonical cycle breakdown.
- This is presentation-only and never mutates borrowers, payment ledger entries, or cycle calculations.

Evidence: `tests/weekly-interest-card-due-summary.test.js`, `tests/interest-borrower-card-ui.test.js`, and `tests/interest-cycle-canonical-contract.test.js`.

## Regular Weekly and Monthly Payment Progress

- Regular Weekly Payment loans default to 10 periods and Regular Monthly Payment loans default to 6 periods when a loan has no saved period.
- Progress is derived read-only from completed scheduled cycles and saved, de-duplicated payment history: `X / Total Weeks Paid` or `X / Total Months Paid`.
- An advance payment cannot be counted until its scheduled cycle completes; edit/delete immediately re-derives progress from the remaining ledger.
- Borrower card dots, borrower-card progress text, and Info page use the same completed-cycle source. History, reports, backup, and restore retain the unchanged saved ledger and re-derive progress rather than persisting a stale counter.

Evidence: `tests/regular-payment-progress.test.js`, `tests/weekly-payment-dot-status.test.js`, `tests/regular-payment-reminder-count.test.js`, and `tests/monthly-loan-workflow.test.js`.

## Interest Payment Receipt Due Snapshot

- At payment save, Weekly and Monthly Interest Loans persist the exact current-cycle start/end date, Current Due, Previous Pending Due, and Total Due used before allocation.
- Receipt, WhatsApp/copy, image receipt, payment-success popup, and payment History read that saved snapshot. They do not recalculate a later ledger cycle for an already saved transaction.
- The displayed order is Current Due, optional Previous Pending Due, Total Due, Payment Date, Paid Amount, Payment Type, and optional Pending Due Amount.
- `Pending Due Amount` is calculated as saved Total Due minus saved Paid Amount. Existing legacy entries without the snapshot retain a read-only compatibility fallback; no historic entry is modified during rendering.

Evidence: `tests/interest-payment-receipt-order.test.js`, `tests/interest-payment-saved-due-snapshot.test.js`, `tests/message-standardization.test.js`, and `tests/interest-cycle-canonical-contract.test.js`.

## Interest Loan Next Week Waiting State

- Selecting Next Week moves Weekly and Monthly Interest Loans into the Closed waiting bucket immediately, without changing any due, pending, payment, or ledger values.
- Weekly Interest reopening is recalculated from the borrower own Main Area or Sub Area collection-day cycle; click and payment dates never become the cycle anchor.
- Monthly Interest reopening uses its saved next monthly cycle date. A configured appointment date takes precedence for either loan type and is the exact reopen date.
- The waiting state is excluded from Active and Upcoming while present. On the saved reopen date it returns to the established normal cycle workflow, with the one-tab precedence guard retained.

Evidence: `tests/next-week-cycle.test.js`, `tests/monthly-loan-workflow.test.js`, `tests/interest-cycle-canonical-contract.test.js`, and `tests/interest-loan-settlement.test.js`.

## Compact Interest Borrower Card Due

- Weekly and Monthly Interest borrower cards use the completed-cycle snapshot only and render exactly one due value.
- A completed cycle with no prior or partial balance displays `Due Amount`; any previous or partial balance displays only the combined `Total Due`.
- Borrower cards do not show separate Previous Pending Due, Current Due, or calculation breakdown rows. Collect and Info retain the detailed canonical breakdown.
- This is read-only presentation logic and does not update borrower, payment, cycle, report, or backup data.

Evidence: `tests/weekly-interest-card-due-summary.test.js`, `tests/interest-borrower-card-ui.test.js`, `tests/monthly-loan-workflow.test.js`, and `tests/interest-cycle-canonical-contract.test.js`.

## Canonical Opening Paid Integrity

- Every loan owns exactly one canonical immutable Opening Paid ledger transaction, including a zero-value Opening Paid transaction for loans created without an opening payment.
- The canonical transaction amount is authoritative. `originalOpeningPaid`, `openingPaidAmount`, and `openingPrev` are compatibility mirrors linked by borrower ID, loan ID, and `openingPaidTransactionId`; edits and recalculation never rewrite the ledger amount or original transaction date.
- Restore/import migration runs only on staged data. Backup preflight performs one atomic, idempotent migration before the immutable snapshot is captured and persists the canonical mapping before export begins.
- Missing legacy rows are created only when the value is unambiguous. Conflicting legacy mirror values are reported and left untouched. Duplicate legacy rows remain preserved, retain their original amount, and are marked balance-neutral so they cannot inflate totals.
- Normal and fast durable saves run an indexed integrity guard that reports exact loan IDs, canonical values, mirror values, and ownership-link conflicts immediately. Unrelated financial records are not deleted, reset, or silently repaired.
- Local Export and Google Drive Backup build, hash, validate, and serialize from the same post-migration immutable snapshot revision.

Evidence: `tests/opening-paid-transaction-audit.test.js`, `tests/google-drive-frozen-snapshot.test.js`, `tests/local-json-export-immutable.test.js`, `tests/info-payment-delete.test.js`, `tests/financial-content-integrity.test.js`, and `npm.cmd run test:data-integrity`.
## Drive Manifest Restore And Next Week Button - v2.4.53

- Baseline protected: encrypted full/incremental Drive backup, immutable snapshot, Opening Paid preflight, restore staging, borrower-owned collection dates, single-tab waiting state, and all financial records.
- Drive root cause: restore normalized the decrypted daily-full payload before checking the record manifest that upload created from the frozen pre-migration payload.
- Drive correction: upload and restore share canonical record ordering, recursively key-sorted serialization, SHA-256 state hashing, and record-manifest version 2. The decrypted snapshot is validated before normalization/migration; new manifests retain per-record hashes for exact mismatch diagnostics.
- Next Week root cause: `apptNextWeek()` referenced popup-local `appointmentWins`, causing a click-time `ReferenceError`.
- Next Week correction: the handler resolves its own borrower appointment override and persists the own-cycle reopen date with one save/render.
- Release gates: focused Drive manifest, Next Week, Opening Paid, local export, interest settlement, and complete `test:data-integrity` suite must pass before APK build.
