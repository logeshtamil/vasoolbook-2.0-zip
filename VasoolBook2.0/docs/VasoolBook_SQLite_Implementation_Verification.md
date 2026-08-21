# VasoolBook SQLite Implementation Verification

Date: 2026-07-22  
SQLite schema: 1  
App version: 2.4.29 (34)  
Package: `in.vasoolbook.app`

## Activation Safety

- Existing IndexedDB/localStorage remains the migration source and recovery copy.
- A complete emergency snapshot is written to IndexedDB and read back with SHA-256 verification before migration starts.
- Migration writes to the separate `vasoolbook_integrity_v1` SQLite database.
- `PRAGMA foreign_keys=ON` is enabled and verified.
- Migration uses `BEGIN IMMEDIATE`, validates counts, paise totals, payload checksum and `foreign_key_check`, then commits.
- The SQLite activation marker is written only after commit, persistence and checksum re-read succeed.
- Any mismatch rolls back SQLite, removes the activation marker and starts the unchanged legacy application state.

## Migrated Tables

The schema contains 39 application tables:

`schema_version`, `migration_runs`, `businesses`, `app_users`, `areas`, `borrowers`, `borrower_contacts`, `borrower_addresses`, `loans`, `loan_relationships`, `loan_term_versions`, `loan_documents`, `loan_schedules`, `schedule_items`, `financial_transactions`, `transaction_allocations`, `payment_tenders`, `loan_events`, `expenses`, `non_account_transactions`, `reminders`, `upi_accounts`, `cashbook_reconciliations`, `report_snapshots`, `app_settings`, `backup_runs`, `backup_record_manifest`, `sync_queue`, `sync_cursors`, `sync_conflicts`, `restore_runs`, `audit_log`, `legacy_id_map`, `tombstones`, `integrity_snapshots`, `migration_staging`, `app_state`, `state_versions`, `entity_state`.

All original fields are retained in `raw_json`/`entity_state` while indexed financial and relationship fields are normalized.

## Financial Controls

- Money is converted to integer paise with decimal-string parsing and overflow rejection.
- Original loan amount and original start date are pinned during migration and protected by a SQLite trigger.
- Payment and allocation rows are immutable.
- A payment correction creates a reversal plus replacement revision.
- A removed payment creates a tombstone revision; historical ledger rows remain present.
- Loan close, Next Week close and reopen transitions append `loan_events`.
- `v_loan_ledger_totals` derives original amount, top-up, opening paid, principal paid, write-off, receipt total, total paid and balance without mutating the loan principal.
- Audit rows are append-only by SQLite trigger.

## Automated Fixture Comparison

The deterministic fixture migrated with no differences:

| Metric | Before | After |
|---|---:|---:|
| Customers | 2 | 2 |
| Loans | 3 | 3 |
| History/ledger records | 5 | 5 |
| Areas | 1 | 1 |
| Expenses | 1 | 1 |
| Non-account transactions | 1 | 1 |
| UPI accounts | 1 | 1 |
| Reminders | 1 | 1 |
| Reports | 1 | 1 |
| Users | 1 | 1 |
| Legacy audit rows | 1 | 1 |
| Original loan total | 8,000,000 paise | 8,000,000 paise |
| Current loan snapshot | 8,000,000 paise | 8,000,000 paise |
| Opening paid | 500,000 paise | 500,000 paise |
| Payment gross | 2,300,000 paise | 2,300,000 paise |
| Principal paid | 2,200,000 paise | 2,200,000 paise |
| Interest paid | 100,000 paise | 100,000 paise |
| Expenses | 25,075 paise | 25,075 paise |
| Non-account total | 100,000 paise | 100,000 paise |

## Tests Passed

- Schema creation, constraints, indexes, views and foreign keys
- Initial migration and emergency snapshot activation gate
- Borrower, new loan and renewed loan preservation
- Opening paid, normal payment and split payment preservation
- Full close, reopen and Next Week event persistence
- Payment edit through reversal/replacement
- Payment delete through tombstone
- Immutable loan origin and append-only audit enforcement
- Deterministic total-paid/balance calculation
- Duplicate sync-queue rejection
- Backup cancellation leaves database bytes unchanged
- Simulated force-close before commit rolls back fully
- Export/reopen retains record counts and financial totals
- Restore staging suppresses intermediate saves and commits once
- Failed invariant save restores the previous committed UI state
- Android Capacitor plugin sync and compile-only Java verification

Commands:

```powershell
npm run test:data-integrity
npx cap sync android
cd android
.\gradlew.bat :app:compileDebugJavaWithJavac
```

## Live Device Migration Report

No phone database was available in the source workspace, and no APK was built as required. Therefore this report does not invent production record counts. On first run, the migration calculates and compares that device's exact counts and paise totals. Any mismatch prevents activation and retains the old storage path. The in-session report is available from `VBSqliteIntegrity.getMigrationReport()`; the durable result is stored in `migration_runs`, `integrity_snapshots` and `audit_log`.

## Residual Risks

- First-run validation against the user's real phone dataset remains device-only and must be observed before declaring that specific dataset migrated.
- Existing records with duplicate IDs, invalid money, or orphan payment-to-loan references deliberately stop migration; they are not silently discarded or guessed.
- Website runtime automation from a direct `file:///` URL was blocked by the browser security policy. Inline JavaScript parsing, SQL runtime simulation, persistence/restart tests and Android compilation passed.
- Gradle reports existing deprecation warnings for future Gradle 9 compatibility; the current Gradle 8.9 compile succeeds.
