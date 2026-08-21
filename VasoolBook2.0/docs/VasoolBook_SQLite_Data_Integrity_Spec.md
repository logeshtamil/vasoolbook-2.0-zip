# VasoolBook SQLite Data-Integrity Specification

Status: design only; no application code or data has been changed  
Audited build: VasoolBook 2.4.28 (versionCode 33)  
Package: `in.vasoolbook.app`  
Target: local SQLite as the offline source of truth, with Turso/libSQL synchronization
Audited source archive: `safety/VasoolBook_PreSQLite_Source_20260722_200119.zip`  
Archive SHA-256: `20BB57AB7848C90C74C950893BF5383BCFF684DE89E463668BBA95922CEDDB69`  
Audit method: archive contents inspected read-only; no source, Android, version, signing, or APK changes were made.

## Required-output map

1. Project data-flow audit: Sections 1-3 and 4.1.
2. Complete data inventory: Section 2, Section 5, and Appendix A.
3. Risk report with evidence: Sections 11-12 and Appendix B.
4. Proposed normalized SQLite schema: Section 4.
5. Field-by-field mapping: Section 5 and Appendix A.
6. Migration plan: Section 6.
7. Transaction boundaries: Section 7.
8. Backup/restore safety design: Sections 6-10 and Section 13.
9. Validation and rollback rules: Sections 8-9.
10. Automated and manual tests: Section 13.
11. Unresolved questions: Section 14.
12. Approval checklist: Section 15.

## 1. Executive decision

VasoolBook currently persists core arrays in IndexedDB with a localStorage mirror, while several other records remain only in independent localStorage keys. The same financial fact is copied into mutable borrower, payment-history, report, and backup objects. Several edit/delete/recalculation paths rewrite historical rows. This makes record loss, stale balances, duplicate restore rows, and reduced totals possible even when each individual function appears to save successfully.

The replacement design must use one local SQLite database as the only authoritative local store. Financial history must be an append-only ledger. UI state, localStorage, and in-memory arrays may cache display data, but may never be authoritative. Turso is a replication/synchronization target, not a substitute for the offline transaction boundary.

Core rules:

1. Every posted payment, disbursement, top-up, waiver, write-off, OTS settlement, opening-paid amount, and reversal is immutable.
2. A correction appends a reversal and a replacement transaction. It never updates or deletes the original financial row.
3. Original loan amount and original start date are immutable columns.
4. Current balances and reports are SQL views over posted ledger rows. Cached values are never used to post another transaction.
5. All money is signed integer paise. JavaScript decimal values are converted once at the boundary.
6. Every multi-table operation is one database transaction and every failure rolls it back.
7. Backup is a read transaction. Restore and sync first stage and validate data, then commit atomically.

## 2. Complete current-data inventory

### 2.1 Current persistence layers

| Current store | Content | Present behavior | Integrity concern |
|---|---|---|---|
| IndexedDB `vasoolbook_store/kv` | `cm_c`, `cm_b`, `cm_l`, `cm_a`, `cm_nat`, `cm_upi` and backup staging | Six JSON strings, with some multi-key atomic writes | No relational constraints; whole-array rewrites; fast save writes two stores before the remaining four |
| localStorage mirror | Same six core keys | Synchronous launch cache | Quota failures and cache/source divergence are possible |
| localStorage-only operational stores | `cm_expenses`, `cm_cashbook`, `cm_rem`, `cm_cfg`, `cm_collReports`, users, sessions, audit, settings, lock and sync metadata | Independent writes | Cannot commit atomically with loans/payments; some data is omitted from backups |
| JavaScript memory | `customers`, `borrowers`, `entryLog`, `areas`, `nonAccTxns`, `upiIds`, `expenses`, `cashBook`, `reminders`, `collReports`, `S` | Mutable arrays/objects drive UI | Critical values can change before durable persistence completes |
| `sessionStorage` | No application records detected | Not used by the audited source | Must remain non-authoritative; never store financial truth here |
| Android native bridge | Backup files, Drive staging, WhatsApp selection preferences, receipt/file exports | Files/MediaStore/cache/SharedPreferences | Not a business-data database; callbacks can outlive UI state |
| Google Drive | Full JSON, encrypted full/incremental files, manifest and revisions | appDataFolder and legacy files | JSON aliases duplicate collections; manifest is not a relational commit log |

### 2.2 Current keys

Core data keys:

- `cm_c`: customer profiles.
- `cm_b` and legacy `cm_lp`: borrower/loan profile objects.
- `cm_l`: payment, opening-paid, top-up, close, OTS, NPA and reopen history.
- `cm_a`: main areas and sub-areas.
- `cm_nat`: non-account cash/bank transactions.
- `cm_upi`: UPI account/QR identifiers.
- `cm_expenses`: expense records.
- `cm_cashbook`: daily/global/area opening and closing balances.
- `cm_rem`: reminders, appointments and snooze metadata.
- `cm_cfg`: business and app settings.
- `cm_collReports`: legacy saved collection reports; current save/load UI functions are disabled.
- `cm_arid` / `cm_retired_area_ids`: retired area identifiers.

Identity, security and audit keys:

- `cm_mum_users`, `cm_mum_session`, `cm_mum_audit`, `cm_mum_ah`.
- `vb_app_lock_v1`: PIN/pattern hashes, salt and biometric preference.
- `vb_license`, installation/device identifiers.
- `cm_sync_meta`, `cm_storage_audit_log`.

Backup/sync keys:

- Local/Drive timestamps, sizes, status and messages under `cm_bk_*`, `cm_rs_*`, `cm_backup_*`.
- `cm_gd_incremental_manifest_v2`, `cm_gd_incremental_pending_v2`, recovery key and recovery-key status.
- `cm_gd_pending_changes`, `cm_gd_upload_queue`, estimated size, health, last sync and last backup kind.
- Restore staging, pending migrated restore, emergency backup and recovery checkpoint keys.
- `cm_local_dirty`, `vb_local_dirty`, write/mirror-inflight markers and IndexedDB overflow markers.

Other preferences/content:

- `vb_auto_sync`, Google web client ID, message templates/history, smart-agent history and UI disclosure state.

### 2.3 Current record inventory

#### Business and users

- Business: company, agent, phone, default area, default payment mode/amount, weekly/monthly periods, week start, default loan type, interest defaults, billing percentage, smart-agent setting, success-popup setting, backup safety and WhatsApp path.
- User: userId, username, name, mobile, deviceId, role, status, PIN, createdAt, createdBy, updatedAt.
- Session: userId, loginTime, deviceId.
- Audit: id, timestamp, user identity, device, action, transaction type, customer name, amount, note and optional sync time.

#### Areas

- areaId/id, name, areaType, parentArea, parentAreaId, collection day, nested subAreas and retired-ID registry.
- Borrower/customer/history rows also contain copied area names and IDs.

#### Customers and contact data

- id, customerId, customer number, name, primary/secondary phone, area/areaId, KYC number, match key, normalized phone, address, latitude, longitude, createdAt and updatedAt.

#### Loan profiles (currently named `borrowers`)

- Identity/linkage: id, loanProfileId, profileType, customerId/custId, customer number, borrowerId, loan number and guarantorId.
- Contact snapshots: name, primary/secondary phone, address, area/areaId, latitude and longitude.
- Origination: loan, principalAmt, originalLoanAmount, baseLoanAmount, originalPrincipal, previous/opening paid values, original start date, loan date, loan end date, document fee, commission amount/rate/number, net issue values and agent.
- Product terms: loanType, isInterest, period, billingAmt, manualPay, interestRate, interestAmt, interest calculation start/basis, weekly/monthly schedule values and previous pending interest.
- Disbursement: loanPayType, cash amount, UPI amount and split flag.
- Security/documents: loanSecurityType and loanDocuments.
- Top-ups: topups/topupHistory arrays containing id, date, amount, interest, amount type, note, payment method and split values.
- Current mutable totals: prev, openingPrev, openingPaidAmount, originalOpeningPaid, remainingPrincipal, interestCredit, last pending/discount/balance-choice fields.
- Lifecycle: completed, closed, paidOff, permanentClosed, finalClosed, closureLocked, status, loanStatus, closureType, closed/completed dates.
- Scheduler: collectionDone, ignored, Next Week anchor/reopen fields, next due/collection dates, scheduledDateTime, monthlyCycleStatus, reminderSnoozed and force-active state.
- OTS linkage/snapshots: source loan, old/principal/current/pending balances, total closure, paid, adjusted and written-off amounts, new-loan amount/interest/net/document fee/cash-on-hand, split/tender fields, group ID and linked new loan ID/number.
- Metadata/preferences: success-popup options, createdAt and updatedAt.

#### History/payment entries (`entryLog`)

- Identity/linkage: id, bid/borrowerId/loanId/loanProfileId, customerId, loan number.
- Borrower snapshots: name, phone, area/areaId, loan amount.
- Date/time: date, paymentDate/paidDate, timestamp, createdAt and updatedAt.
- Financial snapshots: today/paidAmount/amount, total, balance, principalComponent, interestComponent, previous principal and previous pending.
- Tender: pay/bank, cashAmt, upiAmt, upiMethod and split flag.
- Purpose/type: paymentPurpose, entryType/eventType, collection/agent category, remark/source and note/remarks.
- Interest-cycle snapshots: cycle start/end, cycle interest/payments, paid/pending cycle counts and pending amount, due discount, payable amount, total due at payment and remaining pending.
- Pre-closure: selected date, due, pending-cycle due, previous pending, used/total days, per-day amount and cycle range.
- Opening paid: amount/date/migration metadata plus protected, locked, immutable and edit/delete flags; duplicate/superseded markers.
- Top-up: topupId, amount, interest, amount type, due date and principal basis.
- Closure: full paid/full close/paid off, loan closure, discount closure, discount adjustment/reduction/final amount and closing mode.
- OTS: payment/adjustment flags, old balance, paid today, written-off balance, closure totals, new-loan values, tender splits and group links.
- Other lifecycle events: NPA move, reopen identity/date/reason/restored balance and loan creation flags.

#### Schedules and reminders

- Derived weekly/monthly/EMI payment amount, cycle start/end and due dates.
- Borrower Next Week, appointment, payment and upcoming-due states.
- Reminder: id, loan/borrower ID, name, area, phone, datetime, displayDate, note, type, loan number and balance snapshot.

#### Cash, bank, expenses and reports

- Non-account transaction: id, date/timestamp, type (`cash_in`, `cash_out`, `acc_in`, `acc_out`), amount, name, optional borrower, area/main-area IDs and names, payment mode and note.
- Expense: id, date, area/main-area IDs and names, description, amount, mode, category and note.
- Cashbook: date, optional area, opening balance, closing balance, calculated difference and updatedAt.
- Collection report inputs: final cash, cash out, bank collection/deposit, bank disbursement, food, fuel, other, new-loan amount, MIS loan/payment, commission received, interest loan, weekly/interest collection and principal.
- Report outputs: interest less, weekly-loan amount, commission/income, total loan, cash/bank difference, cash on hand, expenses, collections, Result A/B, variance and status.

#### Backup, sync and restore

- Backup envelope: backup/version/schema/app versions, exportedAt, app ID, all collections, legacy key snapshot, migration metadata and per-array integrity summaries.
- Enterprise metadata: user, device, counts, byte size and SHA-256.
- Incremental manifest: format/version, key ID, base full backup, incremental sequence/files, record checksums/versions, state checksum and last summary.
- Pending resumable upload: filename, encrypted content, hashes, offset, session URL, file ID, manifest predecessor and plan.
- Restore state: staged chunks, source file/revision, migration warnings, emergency backup location, before/after counts and status.

### 2.4 Field-level lifecycle dictionary

Appendix A enumerates the exact legacy property names. Every property there inherits the lifecycle rule for its object family below; Section 5 gives its SQLite table, column, conversion, and validation. A stricter field-specific rule in Section 5 takes precedence. Unknown but valid legacy properties must be retained losslessly in `legacy_payload_json` until an approved migration maps them.

| Object | Fields | Current store | Type | Required | Default | Calculation | Relationship | Create | Update | Delete | Export | Restore | Class | Primary risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Root state | Appendix A.1 | IDB `vb-core/state`; localStorage mirrors | Versioned JSON envelope | Yes after bootstrap | Empty arrays and schema defaults | None | Owns legacy arrays | Bootstrap/import | `saveState*` | Reset only | Full/local/Drive serializers | Stage/migrate/validate | Mixed | Split, non-atomic authority |
| Customers | Appendix A.2 | `cm_c`, `customers` | Objects; mixed scalars | Stable ID and identity | Generated ID; optional contact fields null | Display/normalization only | Parent of loans/contacts | Borrower form | Customer edit | Soft-delete target | Customer aliases | Merge by preserved ID | PII/financial link | Alias collision and drift |
| Loans | Appendix A.3 | `cm_b`/`cm_lp`, `borrowers`/`loans` | Objects; money currently floating numeric | Stable ID, customer, original amount/date | Product terms; nullable optionals | Terms + immutable ledger | Child customer; parent payments/schedules | New/renew/OTS/top-up | Terms/status/scheduler | Never hard-delete | Loan aliases | Migrate then merge | Critical financial | Original values overwritten/recalculated |
| Payments/events | Appendix A.4 | `cm_l`, `entryLog`/history aliases | Heterogeneous event objects | Stable ID/link/type/date; amount for financial rows | Posted status; zero only for non-money events | Source for paid/balance/report totals | Child loan/customer; reversal links | Collect/opening/top-up/close | Prohibited after posting | Reversal/soft-delete only | History aliases | Deduplicate by stable identity | Critical ledger | Mutation, deletion, duplicate aliases |
| Areas/schedules | Appendix A.5 | `cm_a`, `areas` | Nested objects/arrays | Area identity; day when scheduled | Empty children; nullable day | Due/reactivation calendar | Parent of assignments/reminders | Area settings | Rename/day/subarea | Soft-delete | `areas` | Merge identity aliases | Operational | Orphans and wrong reactivation |
| Expenses | Appendix A.6 | `cm_expenses` | Objects; numeric money | ID/date/amount/type | Current business date and selected mode/category | Cash/report aggregates | Optional area/account/user | Expense form | Correction becomes reversal | Soft-delete | `expenses` | Merge/dedupe | Financial | Historical cash rewritten |
| Non-borrower transactions | Appendix A.7 | `cm_nat` | Objects; numeric money | ID/date/type/amount | Current date; optional links null | Cash/bank reports | Optional account/area/user | Cash transaction form | Reversal + replacement | Soft-delete | NAT aliases | Merge/dedupe | Financial | Double count and mutable cash |
| Cashbook | Appendix A.8 | `cm_cashbook` | Objects/cache | Business date/source references | Explicit zero only at initialization | Derived from ledger | Projection of financial entries | Record/rebuild | Rebuild cache only | Cache only | Optional compatibility payload | Validate/rebuild | Derived financial | Independent-authority mismatch |
| Reminders | Appendix A.9 | `cm_rem` | Objects | ID, borrower/loan/date | Pending; optional note null | Loan schedule/appointment | Child loan/borrower | Scheduler/user | Snooze/status/reschedule | Soft lifecycle | `reminders` | Merge by ID | Operational | Premature activation/status drift |
| UPI/QR | Appendix A.10 | `cm_upi` | Objects | ID/value when enabled | Empty list; no default account | None | Business/settings child | Settings | Settings | Configuration removal | `upiList` | Merge configuration | Sensitive config | Dangling default/payment route |
| Settings/security | Appendix A.11 | `cm_cfg`, scattered localStorage, native prefs | Scalars/objects | Key-dependent | Explicit schema default per key | Runtime behavior only | Business/user/device | Enrollment/settings | Toggle/input/save | Explicit reset/logout | Policy-filtered settings | Versioned merge | Config/security | Plaintext secrets and divergent defaults |
| Users/session/audit | Appendix A.12 | `cm_mum_*`, localStorage | Objects/append log | Stable actor/event identity | Least privilege; no active session | Audit metadata | User owns sessions/events | Admin/login/logger | User/session only; audit append | User soft-delete; audit retain | Security/audit policy | Validated merge | Security/audit | Audit truncation and weak credentials |
| Backup/sync/restore | Appendix A.13 | JSON files, Drive, IDB staging, metadata keys | Envelope/manifest/chunks | Schema/version/checksum/counts | New versioned pending run | Canonical snapshot metrics | References snapshot/device/user | Backup start | Status/progress | Retention; never last valid | Local/native/Drive | Staging + atomic commit | Recovery | Partial/alias overwrite, live repair |
| Android bridge transport | Appendix A.14 | SharedPreferences/cache/MediaStore/SAF | JSON/string/base64/URI | Correlation/status | Bounded timeout and terminal error | No business calculations | References native operation | Bridge invocation | Progress callback | Verified cache cleanup | File/Drive transport | Pass to web staging | Operational/native | Timeout, truncation, duplicate callback |

`sessionStorage` contains no application records in the audited source. It must not become a source of truth.

## 3. Authority and calculation policy

### 3.1 Authoritative versus derived data

Authoritative:

- Original loan contract, immutable term versions and disbursement.
- Posted financial transactions and their allocations/tender splits.
- Status/lifecycle events, reminder schedule, user actions and audit records.
- Explicit manual cashbook reconciliation.

Derived only:

- `totalPaid`, `balance`, `remainingPrincipal`, pending amount, closing amount, borrower-card totals, history running balance, report totals and backup counts.
- Derived values may be materialized for speed only with a source ledger revision/checksum. They must be discarded and rebuilt if that revision differs.

### 3.2 Canonical financial formulas

All sums include only `status='posted'` rows and exclude reversed rows through their posted reversal entries.

```text
principal_advanced = original_principal
                   + posted principal top-ups
                   + posted positive principal adjustments

principal_reduced  = principal allocations from payments
                   + principal write-offs/waivers
                   + posted negative principal adjustments

principal_balance  = principal_advanced - principal_reduced

interest_due       = posted interest accruals - interest waivers
interest_paid      = posted payment allocations to interest
interest_balance   = interest_due - interest_paid

total_paid         = sum(posted receipt amounts) - sum(posted receipt reversals)
closing_amount     = principal_balance + interest_balance + fee_balance
```

Opening paid is a migrated, immutable prior-payment transaction. It reduces the loan receivable and contributes to lifetime total paid, but it is excluded from current-period cash/bank collections because no money was received by this app during migration/origination.

Cash and bank reports use tender lines, not payment amounts:

```text
cash_position = opening_cash
              + cash inflow tenders
              - cash outflow tenders

bank_position(account) = opening_bank
                       + account inflow tenders
                       - account outflow tenders
```

Historical receipts retain their saved allocation, interest period, rate, principal-before, principal-after and balance-after snapshots. A future formula change must not rewrite those fields.

## 4. Proposed normalized SQLite schema

### 4.1 Storage conventions

- New primary keys are UUIDv7 strings generated by the application.
- Existing IDs are never discarded. A valid existing UUID remains the primary key; otherwise a new UUID is assigned and the exact old value is stored in `legacy_id` and `legacy_id_map`.
- Timestamps are RFC 3339 UTC text. Business dates are ISO `YYYY-MM-DD` and interpreted in the business timezone.
- Money is integer paise with a conservative signed 64-bit range.
- Boolean values are integer `0/1` with checks.
- Tables are `STRICT`; foreign keys are enabled. Local SQLite uses WAL and `synchronous=FULL` for financial commits.
- JSON is allowed only for non-authoritative extension metadata and document descriptors, never as the sole store for financial amounts or relationships.

Required-module coverage uses normalized physical names deliberately; it does not create duplicate financial authorities:

| Requested module | Physical table(s) / view | Design note |
|---|---|---|
| `app_users` | `users`, `user_credentials`, `user_sessions` | Identity, credentials and sessions are separated. |
| `business_profile` | `businesses`, `app_settings` | Typed core identity plus versioned preferences. |
| `main_areas`, `sub_areas` | `areas` | `area_type` and `parent_area_id` implement one constrained hierarchy. |
| `collection_days` | `area_collection_days` | Effective-dated schedule history prevents current area edits from rewriting old due dates. |
| `borrowers`, `borrower_contacts` | `borrowers`, `borrower_contacts`, `borrower_addresses` | Contact/address history is normalized away from borrower identity. |
| `loans`, previous/renewed loans | `loans`, `loan_relationships`, `loan_term_versions` | Original contract fields remain immutable; renewals are linked contracts. |
| `loan_schedules` | `loan_schedules`, `schedule_items` | Contract schedule and generated installments are distinct. |
| `loan_status_history` | `loan_events` | Append-only close, paid-off, OTS, Next Week and reopen facts. |
| `payments`, `payment_allocations` | `financial_transactions`, `transaction_allocations`, `payment_tenders` | One immutable ledger avoids duplicated payment truth. |
| `financial_transactions`, `expenses`, `bank_transactions`, `collection_history` | `financial_transactions` plus typed SQL views | Type constraints distinguish these modules; reports never sum duplicate shadow tables. |
| `reminders`, `next_week_actions` | `reminders`, `loan_events`, `schedule_items` | Reminder state is separate from immutable lifecycle actions and due dates. |
| `reports`, `report_snapshots` | canonical SQL views, `report_snapshots` | Live totals derive from ledger; signed historical reports retain snapshots. |
| `app_settings` | `app_settings` | Typed, scoped and versioned key/value rows. |
| `qr_accounts` | `upi_accounts` | Existing UPI/QR naming is preserved through legacy mapping. |
| `backup_history` | `backup_runs`, `backup_record_manifest` | Snapshot history and row manifest/checksum are separate. |
| `restore_history` | `restore_runs` | Staging, preview, validation and terminal result are auditable. |
| `sync_queue` | `sync_queue`, `sync_cursors`, `sync_conflicts`, `tombstones` | Durable idempotent outbox and explicit conflict handling. |
| `audit_logs` | `audit_log` | Append-only actor/action ledger. |
| `migration_logs` | `migration_runs`, `schema_migrations`, `legacy_id_map` | Versioned migration result and ID provenance. |

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','validated','committed','rolled_back','failed')),
  snapshot_id TEXT,
  source_checksum TEXT NOT NULL,
  staged_checksum TEXT,
  counts_json TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  legacy_id TEXT UNIQUE,
  name TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency_code TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  legacy_id TEXT,
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('Admin','Manager','Collector','Agent')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  credential_hash TEXT,
  credential_salt TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (business_id, username),
  UNIQUE (business_id, legacy_id)
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id TEXT REFERENCES users(id),
  legacy_device_id TEXT,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (business_id, legacy_device_id)
) STRICT;

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE TABLE user_credentials (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id TEXT REFERENCES users(id),
  credential_type TEXT NOT NULL CHECK (credential_type IN ('pin','pattern','biometric_key_ref')),
  secret_hash TEXT,
  secret_salt TEXT,
  secure_key_alias TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((credential_type='biometric_key_ref' AND secure_key_alias IS NOT NULL) OR
         (credential_type<>'biometric_key_ref' AND secret_hash IS NOT NULL AND secret_salt IS NOT NULL)),
  UNIQUE (business_id, user_id, credential_type)
) STRICT;

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  legacy_id TEXT,
  parent_area_id TEXT REFERENCES areas(id) DEFERRABLE INITIALLY DEFERRED,
  area_type TEXT NOT NULL CHECK (area_type IN ('main','sub')),
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((area_type='main' AND parent_area_id IS NULL) OR (area_type='sub' AND parent_area_id IS NOT NULL)),
  UNIQUE (business_id, legacy_id),
  UNIQUE (business_id, parent_area_id, name)
) STRICT;

CREATE TABLE area_collection_days (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  effective_from TEXT NOT NULL CHECK (effective_from GLOB '????-??-??'),
  effective_to TEXT CHECK (effective_to IS NULL OR effective_to GLOB '????-??-??'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (area_id, effective_from)
) STRICT;

CREATE INDEX idx_area_collection_days_current
ON area_collection_days(area_id, effective_from, effective_to)
WHERE deleted_at IS NULL;

CREATE TABLE borrowers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  legacy_id TEXT,
  customer_number TEXT,
  full_name TEXT NOT NULL,
  kyc_number TEXT,
  normalized_match_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (business_id, legacy_id),
  UNIQUE (business_id, customer_number)
) STRICT;

CREATE TABLE borrower_contacts (
  id TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL REFERENCES borrowers(id),
  kind TEXT NOT NULL CHECK (kind IN ('primary_phone','secondary_phone','whatsapp','other')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (borrower_id, kind, normalized_value)
) STRICT;

CREATE TABLE borrower_addresses (
  id TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL REFERENCES borrowers(id),
  area_id TEXT REFERENCES areas(id),
  address_text TEXT NOT NULL DEFAULT '',
  latitude_e7 INTEGER,
  longitude_e7 INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  deleted_at TEXT,
  CHECK (latitude_e7 IS NULL OR latitude_e7 BETWEEN -900000000 AND 900000000),
  CHECK (longitude_e7 IS NULL OR longitude_e7 BETWEEN -1800000000 AND 1800000000)
) STRICT;

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  borrower_id TEXT NOT NULL REFERENCES borrowers(id),
  legacy_id TEXT,
  loan_number TEXT NOT NULL,
  product_type TEXT NOT NULL CHECK (product_type IN ('weekly','monthly','emi','weekly_interest','monthly_interest','interest','legacy_unknown')),
  status TEXT NOT NULL CHECK (status IN ('draft','active','temporarily_closed','paid_off','pre_closed','ots_closed','written_off','cancelled')),
  original_principal_paise INTEGER NOT NULL CHECK (original_principal_paise >= 0 AND abs(original_principal_paise) <= 9000000000000000),
  original_start_date TEXT NOT NULL CHECK (original_start_date GLOB '????-??-??'),
  contractual_end_date TEXT,
  opening_paid_paise INTEGER NOT NULL DEFAULT 0 CHECK (opening_paid_paise >= 0),
  opening_paid_date TEXT,
  opening_paid_date_migration TEXT,
  area_id_at_origination TEXT REFERENCES areas(id),
  current_area_id TEXT REFERENCES areas(id),
  agent_user_id TEXT REFERENCES users(id),
  guarantor_borrower_id TEXT REFERENCES borrowers(id),
  security_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  deleted_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (business_id, legacy_id),
  UNIQUE (business_id, loan_number)
) STRICT;

CREATE TABLE loan_relationships (
  id TEXT PRIMARY KEY,
  from_loan_id TEXT NOT NULL REFERENCES loans(id),
  to_loan_id TEXT NOT NULL REFERENCES loans(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('renewed_as','previous_loan','ots_replacement','manual_reopen_replacement')),
  created_at TEXT NOT NULL,
  CHECK (from_loan_id <> to_loan_id),
  UNIQUE (from_loan_id, to_loan_id, relation_type)
) STRICT;

CREATE TABLE loan_term_versions (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  period_unit TEXT NOT NULL CHECK (period_unit IN ('day','week','month','term')),
  period_count INTEGER NOT NULL CHECK (period_count > 0),
  interest_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (interest_rate_bps >= 0),
  interest_basis TEXT NOT NULL CHECK (interest_basis IN ('flat_cycle','daily_actual','reducing','manual','none','legacy_unknown')),
  scheduled_payment_paise INTEGER CHECK (scheduled_payment_paise IS NULL OR scheduled_payment_paise >= 0),
  default_payment_paise INTEGER CHECK (default_payment_paise IS NULL OR default_payment_paise >= 0),
  commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps >= 0),
  commission_paise INTEGER NOT NULL DEFAULT 0,
  document_fee_paise INTEGER NOT NULL DEFAULT 0,
  net_disbursed_paise INTEGER NOT NULL DEFAULT 0,
  previous_pending_interest_paise INTEGER NOT NULL DEFAULT 0,
  calculation_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (loan_id, version_no)
) STRICT;

CREATE TABLE loan_documents (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  document_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  content_uri TEXT,
  content_sha256 TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE loan_schedules (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  term_version_id TEXT NOT NULL REFERENCES loan_term_versions(id),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('weekly','monthly','emi','interest_cycle','manual')),
  collection_weekday INTEGER CHECK (collection_weekday BETWEEN 0 AND 6),
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','completed','cancelled')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE schedule_items (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES loan_schedules(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  due_date TEXT NOT NULL,
  principal_due_paise INTEGER NOT NULL DEFAULT 0 CHECK (principal_due_paise >= 0),
  interest_due_paise INTEGER NOT NULL DEFAULT 0 CHECK (interest_due_paise >= 0),
  fee_due_paise INTEGER NOT NULL DEFAULT 0 CHECK (fee_due_paise >= 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled','part_paid','paid','waived','cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE (schedule_id, sequence_no)
) STRICT;

CREATE TABLE financial_transactions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  loan_id TEXT REFERENCES loans(id),
  borrower_id TEXT REFERENCES borrowers(id),
  area_id TEXT REFERENCES areas(id),
  legacy_id TEXT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'loan_disbursement','opening_paid','payment','topup','interest_accrual','fee','commission',
    'discount','writeoff','ots_payment','ots_adjustment','expense','cash_in','cash_out',
    'bank_in','bank_out','reversal','migration_adjustment'
  )),
  business_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  gross_paise INTEGER NOT NULL CHECK (abs(gross_paise) <= 9000000000000000),
  status TEXT NOT NULL CHECK (status IN ('draft','posted','void_pending')),
  source TEXT NOT NULL CHECK (source IN ('ui','migration','restore','sync','system')),
  idempotency_key TEXT NOT NULL,
  reverses_transaction_id TEXT REFERENCES financial_transactions(id),
  replacement_for_id TEXT REFERENCES financial_transactions(id),
  created_by TEXT REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  note TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  counterparty_name TEXT NOT NULL DEFAULT '',
  immutable_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  posted_at TEXT,
  deleted_at TEXT,
  CHECK ((status='posted' AND posted_at IS NOT NULL) OR status<>'posted'),
  CHECK (reverses_transaction_id IS NULL OR transaction_type='reversal'),
  UNIQUE (business_id, legacy_id),
  UNIQUE (business_id, idempotency_key)
) STRICT;

CREATE TABLE transaction_allocations (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES financial_transactions(id),
  schedule_item_id TEXT REFERENCES schedule_items(id),
  component TEXT NOT NULL CHECK (component IN ('principal','interest','fee','commission','penalty','writeoff','opening_paid')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  period_start TEXT,
  period_end TEXT,
  principal_before_paise INTEGER,
  principal_after_paise INTEGER,
  balance_after_paise INTEGER,
  calculation_rule_version TEXT NOT NULL,
  UNIQUE (transaction_id, component, schedule_item_id, period_start, period_end)
) STRICT;

CREATE TABLE payment_tenders (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES financial_transactions(id),
  tender_type TEXT NOT NULL CHECK (tender_type IN ('cash','upi','bank','other','noncash_adjustment')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  upi_account_id TEXT REFERENCES upi_accounts(id),
  reference_number TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE loan_events (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created','terms_changed','topup','temporarily_closed','next_week','appointment','reminder_snooze',
    'reactivated','pre_closed','full_paid','ots_closed','written_off','npa_moved','manual_reopen','renewed','deleted'
  )),
  event_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  effective_until TEXT,
  related_transaction_id TEXT REFERENCES financial_transactions(id),
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  legacy_id TEXT,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('payment','appointment','collection','other')),
  scheduled_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','fired','dismissed','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (loan_id, legacy_id)
) STRICT;

CREATE TABLE upi_accounts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  legacy_id TEXT,
  label TEXT NOT NULL,
  vpa TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  qr_payload TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (business_id, vpa),
  UNIQUE (business_id, legacy_id)
) STRICT;

CREATE TABLE cashbook_reconciliations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  area_id TEXT REFERENCES areas(id),
  business_date TEXT NOT NULL,
  opening_paise INTEGER NOT NULL,
  counted_closing_paise INTEGER NOT NULL,
  calculated_closing_paise INTEGER NOT NULL,
  variance_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','reconciled','superseded')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES cashbook_reconciliations(id),
  UNIQUE (business_id, area_id, business_date, status)
) STRICT;

CREATE TABLE report_snapshots (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  area_id TEXT REFERENCES areas(id),
  report_type TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  ledger_revision TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  superseded_at TEXT
) STRICT;

CREATE TABLE app_settings (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('string','integer','boolean','json','secret_ref')),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, setting_key)
) STRICT;

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('local_full','drive_full','drive_incremental','emergency','pre_migration')),
  status TEXT NOT NULL CHECK (status IN ('started','staged','uploaded','verified','failed','cancelled')),
  schema_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  record_counts_json TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  database_checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_space TEXT NOT NULL,
  remote_file_id TEXT,
  remote_revision_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_text TEXT
) STRICT;

CREATE TABLE backup_record_manifest (
  backup_run_id TEXT NOT NULL REFERENCES backup_runs(id),
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  row_version INTEGER NOT NULL,
  row_checksum_sha256 TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('full','upsert','tombstone')),
  PRIMARY KEY (backup_run_id, table_name, record_id)
) STRICT;

CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  entity_table TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
  row_version INTEGER NOT NULL,
  payload_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','acked','retry','conflict','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entity_table, entity_id, row_version)
) STRICT;

CREATE TABLE sync_cursors (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  remote_cursor TEXT NOT NULL DEFAULT '',
  last_pushed_at TEXT,
  last_pulled_at TEXT,
  last_verified_checksum TEXT,
  PRIMARY KEY (business_id, device_id)
) STRICT;

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_table TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_version INTEGER NOT NULL,
  remote_version INTEGER NOT NULL,
  local_checksum TEXT NOT NULL,
  remote_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved_local','resolved_remote','merged')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE restore_runs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  source_type TEXT NOT NULL,
  source_file_id TEXT,
  source_checksum TEXT NOT NULL,
  emergency_backup_run_id TEXT NOT NULL REFERENCES backup_runs(id),
  mode TEXT NOT NULL CHECK (mode IN ('preview','merge','replace')),
  status TEXT NOT NULL CHECK (status IN ('staged','validated','committed','rolled_back','failed','cancelled')),
  before_counts_json TEXT NOT NULL,
  incoming_counts_json TEXT NOT NULL,
  after_counts_json TEXT,
  before_totals_json TEXT NOT NULL,
  after_totals_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_text TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  actor_user_id TEXT REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  action TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id TEXT,
  transaction_id TEXT REFERENCES financial_transactions(id),
  before_checksum TEXT,
  after_checksum TEXT,
  amount_paise INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE legacy_id_map (
  entity_type TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  PRIMARY KEY (entity_type, legacy_id)
) STRICT;

CREATE TABLE tombstones (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  entity_table TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  deleted_by TEXT REFERENCES users(id),
  reason TEXT NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (entity_table, entity_id, row_version)
) STRICT;

CREATE TABLE integrity_snapshots (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  reason TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  counts_json TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  relationship_errors INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

Required indexes:

```sql
CREATE INDEX idx_areas_parent ON areas(parent_area_id, deleted_at);
CREATE INDEX idx_borrowers_name ON borrowers(business_id, full_name COLLATE NOCASE, deleted_at);
CREATE INDEX idx_contacts_value ON borrower_contacts(normalized_value, deleted_at);
CREATE INDEX idx_loans_borrower_status ON loans(borrower_id, status, deleted_at);
CREATE INDEX idx_loans_area_status ON loans(current_area_id, status, deleted_at);
CREATE INDEX idx_schedule_due ON schedule_items(due_date, status);
CREATE INDEX idx_tx_loan_date ON financial_transactions(loan_id, business_date, occurred_at, id);
CREATE INDEX idx_tx_borrower_date ON financial_transactions(borrower_id, business_date, occurred_at, id);
CREATE INDEX idx_tx_type_status ON financial_transactions(business_id, transaction_type, status, business_date);
CREATE INDEX idx_alloc_tx_component ON transaction_allocations(transaction_id, component);
CREATE INDEX idx_events_loan_date ON loan_events(loan_id, event_date, occurred_at);
CREATE INDEX idx_reminders_due ON reminders(status, scheduled_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_table, entity_id, occurred_at);
CREATE INDEX idx_sync_pending ON sync_queue(status, next_attempt_at, created_at);
CREATE INDEX idx_backup_time ON backup_runs(business_id, completed_at, status);
CREATE UNIQUE INDEX uq_cashbook_scope_date
  ON cashbook_reconciliations(business_id, ifnull(area_id,''), business_date)
  WHERE status='open';
```

### 4.2 Immutability guards

Posted financial rows and their allocations/tenders must be protected by triggers. The application posts a draft only after tender and allocation sums validate.

```sql
CREATE TRIGGER financial_transactions_no_update_posted
BEFORE UPDATE ON financial_transactions
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted financial transaction is immutable');
END;

CREATE TRIGGER financial_transactions_no_delete
BEFORE DELETE ON financial_transactions
BEGIN
  SELECT RAISE(ABORT, 'financial transactions must be reversed, not deleted');
END;

CREATE TRIGGER allocations_no_update_posted
BEFORE UPDATE ON transaction_allocations
WHEN EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id=OLD.transaction_id AND t.status='posted')
BEGIN
  SELECT RAISE(ABORT, 'posted allocation is immutable');
END;

CREATE TRIGGER allocations_no_delete_posted
BEFORE DELETE ON transaction_allocations
WHEN EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id=OLD.transaction_id AND t.status='posted')
BEGIN
  SELECT RAISE(ABORT, 'posted allocation cannot be deleted');
END;
```

Application invariants before changing a draft to posted:

- Payment: sum of positive tenders equals `gross_paise`.
- Payment: sum of principal, interest, fee and penalty allocations equals `gross_paise`.
- Non-cash waiver/write-off: tender type is `noncash_adjustment`; it is excluded from collection and cash reports.
- Reversal: same absolute component/tender values as the original with opposite accounting effect and a unique `reverses_transaction_id`.
- Only one unreversed opening-paid transaction per loan.
- A paid-off/OTS/pre-closed loan cannot become active through scheduler logic. Reactivation requires an explicit `manual_reopen` event or a separately created renewed loan.

### 4.3 Canonical views

The implementation should expose views such as:

- `v_loan_principal_balance`: original principal plus top-ups/adjustments minus principal/opening-paid/write-off allocations.
- `v_loan_interest_balance`: interest accruals minus interest payment/waiver allocations.
- `v_loan_totals`: lifetime cash received, opening paid, principal paid, interest paid, fee paid and closing amount.
- `v_daily_tender_totals`: cash, UPI and bank totals from tender rows.
- `v_due_loans`: active loans joined to their own current area and next unpaid schedule item.
- `v_borrower_history`: chronological immutable transaction/event stream.
- `v_report_totals`: source for cards, reports, receipts and WhatsApp messages.

Every screen must query the same view/repository DTO. Receipt, history, borrower card, reports and WhatsApp must not implement separate balance formulas.

## 5. Field-by-field legacy mapping

### 5.1 Customers, areas and identity

| Current field | SQLite target | Rule |
|---|---|---|
| customer `id`, `customerId` | `borrowers.id` / `legacy_id_map` | Preserve exact legacy value; assign UUID only when needed |
| `custNo` | `borrowers.customer_number` | Unique per business; collision becomes migration warning requiring review |
| `name` | `borrowers.full_name` | Trim only; preserve original in staged raw JSON |
| `phone`, `phone2`, `phoneClean` | `borrower_contacts` | Separate rows; normalized phone indexed |
| `address`, `lat`, `lng` | `borrower_addresses` | Coordinates stored as E7 integers |
| `kycNo`, `matchKey` | `borrowers.kyc_number`, `normalized_match_key` | Never expose in logs/backups without encryption |
| area `areaId/id`, `name`, `areaType` | `areas` | Preserve IDs; normalize main/sub hierarchy with `parent_area_id` |
| area `day` / collection day | `area_collection_days.weekday` | Map Sunday=0 through Saturday=6; retain effective dates so later edits do not rewrite historical schedules |
| `parentArea`, `parentAreaId`, `subAreas` | `areas.parent_area_id` | Resolve ID first, then exact normalized name; ambiguity is critical |
| copied `area`/`areaId` on old records | current FK plus immutable transaction snapshot JSON | Do not rewrite historical labels when an area is renamed |

### 5.2 Loan profile

| Current field(s) | SQLite target | Rule |
|---|---|---|
| `id`, `loanProfileId` | `loans.id`, `legacy_id` | One canonical loan ID |
| `customerId`, `custId`, `borrowerId` | `loans.borrower_id` | Resolve through ID map; no orphan allowed |
| `loanno` | `loans.loan_number` | Preserve; unique within business |
| `loan`, `principalAmt`, `originalLoanAmount`, `baseLoanAmount`, `originalPrincipal` | `loans.original_principal_paise`, ledger top-ups | Choose immutable origination value using evidence rules; never replace it with current balance |
| `loandate`, `loanStartDate`, `originalLoanDate` | `loans.original_start_date` | Earliest explicitly locked/origination date; retain conflicts in migration warning/raw stage |
| `loanend`, `loanEnd` | `loans.contractual_end_date` | Contract date, never derived balance |
| `openingPaidAmount`, `openingPrev`, `originalOpeningPaid` | `loans.opening_paid_paise` plus opening-paid transaction | Exactly one active immutable entry |
| `openingPaidDate`, migration flag | loan columns and opening transaction date/snapshot | Missing date may use original start, created date, or null warning |
| `loanType`, `isInterest`, `period` | loan product and `loan_term_versions` | Unknown legacy values are preserved as `legacy_unknown` with raw value |
| `interestRate` | `interest_rate_bps` | Percent to basis points; e.g. 3.5% = 350 bps |
| `interestCalcStart`, basis fields | term effective date/basis and schedule | Never overwrite original start date |
| `interestAmt`, `billingAmt`, `manualPay` | term/schedule snapshots | Store contractual values; current pending remains derived |
| `commission`, `commissionSet`, `commissionNo` | term commission fields/snapshot | Paise or basis points according to saved mode |
| `docFee` | `document_fee_paise` | Financial fee transaction if actually charged |
| issue cash/UPI/split fields | disbursement transaction and tenders | Tender sum must equal net disbursed amount |
| `prev`, `remainingPrincipal`, current pending/balance fields | no authoritative column | Compare during migration, then derive from ledger |
| `topups`, `topupHistory` | top-up transactions, allocations, loan events | Deduplicate against `entryLog.topupId`; never store a second authoritative array |
| closure/status flags and dates | `loans.status`, `loan_events`, closing transaction | Closure amount must be represented by payment plus explicit write-off/discount allocations |
| Next Week/appointment/reopen fields | `loan_events`, schedule and reminders | `effective_until` is exact own-area reactivation date |
| OTS fields | OTS payment/adjustment transactions, event and loan relationship | Cash paid and non-cash write-off must remain distinct |
| `loanDocuments`, security type | `loan_documents`, loan security field | File hash and metadata retained |
| renewed/previous/new-loan IDs | `loan_relationships` | No overwrite of old loan; new contract has a new UUID |

### 5.3 `entryLog`

| Current field(s) | SQLite target | Rule |
|---|---|---|
| `id` | `financial_transactions.id` / `legacy_id` | Preserve exactly |
| `bid`, loan IDs | `financial_transactions.loan_id` | Foreign key required |
| `customerId` | borrower relation | Validate against loan borrower |
| `today`, `paidAmount`, `amount` | `gross_paise` | One selected source; conflicts logged |
| `principalComponent`, `interestComponent` | `transaction_allocations` | Preserve saved components; do not recompute history |
| `cashAmt`, `upiAmt`, `upiMethod`, `pay`, `bank`, `isSplit` | `payment_tenders` | Sum must match gross for actual receipts |
| `total`, `balance`, `remainingPending` | immutable snapshot JSON and derived views | Keep for forensic comparison only, never as current truth |
| payment/entry/event purpose fields | transaction/event type | Deterministic classifier with an `unclassified` migration queue, not silent discard |
| cycle/pre-closure fields | allocations and immutable calculation snapshot | Preserve dates, day counts, rates and amounts exactly |
| opening-paid protection fields | opening transaction and snapshot | Duplicate rows remain archived but balance-neutral; one canonical row |
| top-up fields | top-up transaction/allocation/event | Link via topupId/legacy mapping |
| full-paid/pre-close/discount flags | payment + discount/write-off transaction and close event | Never force balance zero without a matching ledger reduction |
| OTS payment/adjustment fields | separate cash payment and noncash adjustment rows | Prevent inflated collection totals |
| reopen/NPA fields | `loan_events` | Zero-amount event, not a payment |
| `date`, `ts`, `createdAt`, `updatedAt` | business date and occurred/created timestamps | Stable chronological tie-breaker is transaction UUID |

### 5.4 Operational data

| Current data | SQLite target | Rule |
|---|---|---|
| reminders/appointments | `reminders` and loan events | Cancelling uses status/soft delete; must not directly reopen a permanently closed loan |
| expenses | expense financial transaction plus tender | Delete becomes reversal/tombstone |
| non-account transactions | cash/bank financial transactions and tender | Optional borrower/area FKs retained |
| cashbook | `cashbook_reconciliations` | New edit supersedes old row; ledger remains unchanged |
| UPI IDs/QR | `upi_accounts` and settings | Soft delete; referenced tenders remain valid |
| collection reports | SQL views; optional `report_snapshots` | Saved snapshot includes ledger revision/checksum |
| settings | `app_settings` | Typed values and row versions; secrets are references to OS secure storage |
| users/session/audit | normalized user/device/session/audit tables | PIN is migrated to a strong salted hash; never plaintext |
| Drive/local backup state | backup tables | Status changes cannot touch financial tables |
| incremental manifest/queue | manifest and `sync_queue` | Record checksum/version per canonical row |
| restore history | `restore_runs` | Before/incoming/after counts and totals retained permanently |

## 6. Migration plan

Migration is sequential, restartable and never runs directly against the only copy.

### Phase 0: freeze and snapshot

1. Pause UI writes and await every pending IndexedDB write.
2. Read IndexedDB core keys and localStorage mirrors independently.
3. Compare counts and checksums. IndexedDB wins only for keys where it is complete and valid; disagreement is recorded, not silently hidden.
4. Include all localStorage-only keys, app-lock/user/audit settings and backup metadata.
5. Create `Emergency_PreSQLite_<timestamp>.json` and a byte-for-byte database migration package.
6. Re-read the snapshot, verify SHA-256, byte size and all collection counts before continuing.

### Phase 1: raw staging

1. Create a new SQLite file; never migrate in place on the first release.
2. Insert each source object into temporary `legacy_*_stage` tables with source key, array index, raw JSON, extracted legacy ID and SHA-256.
3. Commit staging only after staged object counts equal source counts exactly.
4. No source record may be dropped for an unknown type or optional missing field.

### Phase 2: identity and relationships

1. Build `legacy_id_map` for customers, loans, areas, entries, reminders, expenses and users.
2. Preserve valid UUIDs. Generate UUIDv7 only for missing/non-UUID primary IDs and retain the original as `legacy_id`.
3. Resolve duplicate aliases (`id/customerId`, `id/loanProfileId`, `bid/loanId`) by exact ID first.
4. Use normalized name/phone/date matching only for legacy records without IDs; ambiguous matches stop the migration for review.
5. Insert areas before borrower addresses, borrowers before loans, and loans before transactions using deferred foreign keys.

### Phase 3: money conversion

1. Parse legacy numeric text without binary floating-point arithmetic.
2. Convert rupees to paise by decimal-string scaling and deterministic half-away-from-zero rounding.
3. Store original raw value and conversion decision in staging/audit metadata.
4. Reject NaN, Infinity, malformed signs and values outside the 64-bit safety range.
5. A zero is valid and must not be treated as missing.

### Phase 4: loans and ledger

1. Select original principal from explicit immutable fields first; use loan-creation history next; use current `loan` only as final fallback with a warning.
2. Preserve original start date in the same evidence order.
3. Insert one opening-paid transaction per loan. Duplicate legacy rows are imported as reversed/balance-neutral migration records linked to the canonical transaction.
4. Import payment allocations exactly when saved components exist.
5. For legacy rows lacking allocations, reconstruct once using the historical term/rate and principal immediately before that row. Mark `calculation_rule_version='legacy-migration-v1'` and retain the original row snapshot.
6. Import top-ups once by topupId. Reconcile borrower top-up arrays against history; disagreement is a warning/hold, never a double addition.
7. Split OTS and discount rows into receipt and non-cash adjustment components so cash reports remain correct.
8. Infer paid-off/OTS/pre-close only when history evidence and ledger balance agree. Conflicts remain closed for safety and are flagged for review; they are never auto-reopened.

### Phase 5: operational data

1. Import schedules, exact Next Week/appointment dates, reminders and closure events.
2. Import expenses and non-account transactions as posted transactions.
3. Import cashbook rows as reconciliations without changing ledger transactions.
4. Import settings, UPI/QR, users, devices, app-lock metadata, audit history, backup metadata and restore history.
5. Plaintext user PIN values must not be copied as plaintext; hash them during migration and erase only the new database staging copy after successful verification. The emergency snapshot remains encrypted/protected.

### Phase 6: validation before commit

The migration cannot be marked committed unless all critical gates pass:

- Source and staged counts match for every collection.
- Every legacy ID appears in `legacy_id_map` or an explicit preserved-unclassified table.
- `PRAGMA foreign_key_check` returns zero rows.
- No duplicate business/customer/loan/transaction identity violates a unique constraint.
- Loan original principal and original date are non-null and equal the selected migration evidence.
- Sum of source payment gross, principal components, interest components, opening paid, top-ups, discounts/write-offs, expenses, cash and bank tenders equals migrated totals in paise.
- Every payment tender and allocation balances.
- Every loan satisfies the balance equation.
- Closed loans have a closure event and zero closing amount, or are flagged as a blocking inconsistency.
- Per-area and all-business report totals reconcile with the ledger.
- Canonical database content checksum and integrity snapshot are created.

### Phase 7: atomic activation

1. Close the validation transaction.
2. Atomically rename/select the verified SQLite database as active.
3. Record `schema_migrations`, `migration_runs` and audit entries.
4. Keep the emergency snapshot and old stores read-only for at least one verified release cycle.
5. Application startup compares an activation marker, schema version and integrity snapshot before accepting SQLite.

## 7. Transaction boundaries

| Operation | Single transaction contents |
|---|---|
| Create borrower | borrower, contacts, address, area relation, audit and sync-outbox rows |
| Create loan | loan, initial term, schedule, disbursement transaction/tenders, optional opening-paid transaction, creation event, audit and outbox |
| Save payment | draft transaction, tenders, allocations, schedule status, loan lifecycle event if closing, audit and outbox; validate then post |
| Split payment | payment and every cash/UPI/bank tender together; mismatch aborts all |
| Edit/correct payment | reversal of original, replacement transaction, allocations/tenders, audit and outbox |
| Delete payment | reversal plus tombstone request; original remains visible in audit/history |
| Top-up | top-up transaction/allocation, new term version if required, schedule supersession/rebuild, event, audit and outbox |
| OTS/pre/full close | receipt, explicit waiver/write-off allocation, close event/status, schedule cancellation, audit and outbox |
| Manual reopen/renew | explicit event or new linked loan; never scheduler-only mutation |
| Next Week/appointment | exact event and reminder/schedule update based only on that loan’s area; audit and outbox |
| Expense/NAT | financial transaction, tender, optional area/borrower relation, audit and outbox |
| Cashbook reconciliation | superseding reconciliation row and audit; no historical row update |
| Settings/user change | typed setting/user version, audit and outbox |
| Backup | one consistent read transaction; only backup-status tables may be written afterward |
| Restore | emergency snapshot, staging/import validation, merge/apply, integrity snapshot, restore/audit rows in one exclusive commit |
| Remote sync pull | stage remote events, verify versions/checksums/FKs/totals, apply and acknowledge in one transaction |

## 8. Validation rules

### Critical failures

- Unreadable/corrupt source JSON or SQLite page/checksum failure.
- Missing borrower for a loan or missing loan for a financial history row after ID resolution.
- Duplicate canonical ID/idempotency key.
- Invalid/non-convertible money, overflow or unbalanced tender/allocation.
- Original principal/start date would be overwritten or reduced without evidence.
- Source count or financial total decreases between snapshot, staging and commit.
- Foreign-key failure.
- Backup checksum mismatch, unsupported encryption, or missing required core collection.
- Restore would remove a newer local record without an explicit conflict decision.

### Warnings that do not discard records

- Missing opening-paid date that can be repaired from original start/created date or retained null with migration flag.
- Missing optional phone, address, KYC, note, document or display snapshot.
- Legacy unknown loan/payment type preserved for review.
- Historical running-balance snapshot differs from canonical ledger result.
- Duplicate opening-paid/history alias preserved as balance-neutral/reversed.
- Area name exists but legacy area ID is absent and matching is unambiguous.

### Continuous database checks

- `PRAGMA quick_check` at normal startup; scheduled `integrity_check` before migration/full backup.
- `PRAGMA foreign_key_check` after every migration and restore staging run.
- Counts/totals/integrity checksum snapshot after every restore and app-version migration.
- Validate nonnegative principal/interest/fee balances unless a specifically approved overpayment credit exists.
- Verify paid-off loans cannot enter due/active views.
- Verify each transaction’s tender sum and allocation sum.
- Verify no reversed transaction is counted without its reversal effect.

## 9. Rollback rules

1. Any SQL error, validation failure, user cancellation, timeout, process death or native callback error before commit calls `ROLLBACK` and leaves the active database byte-for-byte unchanged.
2. A backup failure changes only `backup_runs`/queue status; it never writes borrower, loan, transaction or report tables.
3. Drive authorization cancel, popup close and network failure only cancel queued work. They do not reload, reset, merge or recalculate local data.
4. Restore always creates and verifies an emergency full snapshot first. Restore data stays in staging tables until all critical validation passes and the user confirms.
5. Merge restore uses UUID/idempotency key and row version. Equal IDs with unequal immutable financial content become conflicts; neither version is silently overwritten.
6. Replace restore means “replace mutable reference/configuration state from the backup while preserving post-backup immutable local transactions.” It never truncates the live ledger.
7. Migration activation failure retains the old active storage marker and deletes only the unactivated SQLite candidate after diagnostics are recorded.
8. Sync retries are idempotent. An acknowledgement is recorded only after local and remote checksums match.

## 10. Turso/libSQL architecture

### Android

- Use a maintained Capacitor SQLite/native SQLite layer for the local file.
- All repository methods operate locally first. UI success is returned only after local commit.
- An outbox worker sends immutable events and versioned entity changes to a trusted synchronization API/Turso.
- Never embed a permanent Turso database auth token in `index.html`, Capacitor config or APK resources. Use authenticated short-lived scoped tokens or a backend gateway.

### Website

- Use SQLite WASM with OPFS for the local source of truth where supported; provide an explicit unsupported-browser fallback that does not pretend localStorage is equivalent durability.
- The same schema, migration versions, UUID/idempotency rules and outbox protocol apply.

### Conflict policy

- Immutable financial transactions union by UUID/idempotency key. Same ID plus different checksum is a hard conflict.
- Mutable borrower/contact/settings rows use monotonic `row_version`, device ID and audit history; concurrent changes require deterministic field merge or user review.
- Deletions are tombstones, synchronized like any other versioned row.
- Loan closure dominates scheduler activation. Only an explicit later manual-reopen/new-loan event can supersede it.
- Server time may order sync events, but business dates and saved financial calculations are never rewritten.

## 11. Known current risks

### Critical

1. Financial truth is duplicated across `borrowers`, `entryLog`, opening-paid rows, top-up arrays and reports. Recalculation can overwrite `prev`, remaining principal, entry totals and balances.
2. Payment edit/delete and top-up edit/delete physically mutate or remove history instead of appending reversals.
3. Historical entry metadata and amounts are rewritten using the borrower’s current loan/name/area/phone. This destroys the original transaction snapshot.
4. OTS/discount adjustment amounts can appear in `today`, so non-cash reductions may inflate paid/cash totals.
5. Core arrays and localStorage-only stores have no single transaction. A crash can commit payments without settings/cashbook/audit or vice versa.
6. Restore matching can overwrite local records by ID with backup objects, while duplicate aliases make count checks appear valid even when semantic content differs.

### High

7. Money uses `parseFloat`, binary floating-point arithmetic and mixed rounding. Paise-level drift is possible.
8. `saveStateFast` commits borrower/history keys separately from the remaining stores.
9. Several deletes are physical: payment rows, top-ups, expenses, reminders, users, areas and non-account transactions.
10. Area rename/delete mutates copied historical labels and relationships.
11. Backup construction calls opening-paid repair and can mutate live state during an operation expected to be read-only.
12. Backup aliases (`borrowers/loanProfiles`, `entryLog/historyTab/paymentHistory`, two borrower-wise maps) can disagree and multiply restore complexity.
13. Users, sessions, audit, lock, templates, license and some sync metadata are outside the main atomic backup payload.
14. Current audit is optional for one user, auto-purged after three months and capped at 5,000 rows.
15. User-management PIN is stored as plaintext in localStorage; other PII is also unencrypted at rest.

### Medium

16. IDs use mixed random/time IDs, business numbers and aliases rather than one UUID policy.
17. Dates mix date-only strings, local datetime strings and UTC ISO timestamps; scheduler behavior can vary by timezone/resume.
18. Collection report inputs use hardcoded percentages and float arithmetic; saved report functions are disabled while legacy cached rows remain.
19. Cashbook records are mutable objects keyed by date/area without revision history.
20. Reminder deletion can change loan activity state, coupling a notification record to financial lifecycle state.
21. Integrity checks emphasize counts and duplicate IDs but do not prove payment allocations, tender totals, loan balance equations or report reconciliation.
22. Android native file/Drive staging is useful for transport but cannot guarantee database consistency without a SQLite read snapshot and restore transaction.

## 12. Explicit protection for the known reduction/erasure bug

The current bug class occurs when `loan`, loan-end/closing amount, `prev`, remaining principal or total-paid snapshots are treated as interchangeable and a later edit/recalculation writes a smaller derived value back over an original value.

The SQLite design prevents it as follows:

1. `loans.original_principal_paise` and `original_start_date` are immutable contract facts.
2. Top-ups are additive posted transactions; they never change original principal.
3. Total paid is a ledger sum, never a borrower-column assignment.
4. Closing amount is a view result. Closing requires payment and/or explicit waiver/write-off allocations that bring each component to zero.
5. Historical payment allocations and snapshots are trigger-protected after posting.
6. A correction reverses the original; both rows remain in history and audit.
7. Migration validates original principal, lifetime receipts, principal/interest allocations and closing totals before activation.
8. Restore cannot lower totals silently. A same-ID/different-checksum financial record is a blocking conflict.
9. Paid-off/OTS/pre-closed status cannot reopen from schedule refresh, reminder deletion, app restart or background resume.

## 13. Data-integrity test checklist

### Migration

- [ ] IndexedDB and localStorage are independently inventoried and discrepancy report is produced.
- [ ] Emergency snapshot opens, hashes correctly and has exact source counts/totals.
- [ ] Every source array item has a staging row and migration disposition.
- [ ] Every old ID is preserved and every relationship resolves.
- [ ] Rupee-to-paise conversion is exact for integers, decimals, zero, large values and negative adjustments.
- [ ] Missing optional fields produce warnings, never discarded records.
- [ ] Opening-paid legacy variants create exactly one effective transaction per loan.
- [ ] Full Paid, OTS, pre-closed and manually closed loans remain closed with zero canonical closing amount.
- [ ] `foreign_key_check` and integrity checksum pass before activation.

### Loan and payment ledger

- [ ] New weekly, monthly, EMI and interest loans retain original principal/date permanently.
- [ ] Disbursement cash/UPI splits sum to net disbursement.
- [ ] Default/scheduled payment settings generate schedule values without altering contract history.
- [ ] Cash, UPI, bank and split payments post once under rapid/double tap.
- [ ] Payment edit creates reversal plus replacement; original remains unchanged.
- [ ] Payment delete creates reversal; counts/history/audit remain traceable.
- [ ] Top-up adds principal once and produces one linked event/transaction.
- [ ] Repeated import/restore cannot duplicate top-up or opening-paid records.
- [ ] Interest allocations retain their saved cycle, rate and date calculation.
- [ ] Full Paid amount equals principal plus interest due on selected payment date.
- [ ] OTS separates cash received from write-off; collection totals include only cash received.
- [ ] Closing requires component balances to reach zero and cannot erase original amount.
- [ ] Reopen requires an explicit manual event/new linked loan.

### Balance and report reconciliation

- [ ] Borrower card, history row, receipt, WhatsApp, reports and backup preview use the same canonical totals query.
- [ ] Per-loan: original plus top-ups equals principal paid plus write-offs plus current principal balance.
- [ ] Lifetime total paid equals unreversed receipt tenders; opening paid is separately identified.
- [ ] Daily cash total equals cash tenders, not generic payment amounts.
- [ ] UPI/bank totals reconcile per account and date.
- [ ] Expense and non-borrower totals reconcile to ledger and area reports.
- [ ] Overall software totals equal sum of per-loan/per-tender components with no alias double count.
- [ ] Cashbook variance equals counted close minus ledger-calculated close.

### Scheduling and lifecycle

- [ ] Next Week uses only the loan’s current assigned area schedule and minimum seven-day rule.
- [ ] Appointment date overrides area schedule only for that loan.
- [ ] Refresh, timezone, restart and background resume do not reactivate before exact effective date.
- [ ] A loan appears in exactly one Active/Upcoming/Closed state.
- [ ] Permanent closure dominates reminders and schedulers.

### Backup, restore and sync

- [ ] Backup uses one consistent read transaction and does not mutate any business row.
- [ ] Cancel, timeout, authorization failure and network failure leave database checksum unchanged.
- [ ] Full/incremental manifests contain row versions, tombstones and SHA-256 values.
- [ ] Upload verification confirms remote size/checksum before success.
- [ ] Restore preview performs no writes to live tables.
- [ ] Emergency snapshot is verified before restore.
- [ ] Merge restore preserves newer local events and rejects same-ID/different-content conflicts.
- [ ] Replace restore does not delete post-backup local immutable transactions.
- [ ] Failed restore rolls back all tables, counts, totals and checksums.
- [ ] Repeated restore is idempotent.
- [ ] Multi-device outbox retries do not duplicate payments.

### Security and audit

- [ ] No plaintext PIN, Turso token, recovery key or client secret exists in HTML/localStorage/logs.
- [ ] Every create, update, correction, reversal, soft delete, restore, migration, close, reopen and adjustment has an audit row.
- [ ] Audit rows cannot be disabled, edited, purged by ordinary users or silently truncated.
- [ ] Backup files are encrypted and recovery keys are held outside ordinary app storage.
- [ ] Sensitive logs redact phone, KYC, access tokens and backup plaintext.

## 14. Unresolved questions requiring approval

These questions must be answered before implementation. None permits delaying raw, lossless preservation of the corresponding legacy fields.

1. Which legacy meaning of `prev`, `openingPrev`, and `openingPaidAmount` is authoritative when their values disagree with protected opening-paid history?
2. For OTS, which components are cash received, contractual waiver, write-off, discount, and principal transfer into a renewed loan? Each requires a distinct immutable ledger type.
3. Which saved report values are legally significant snapshots, and which may be rebuilt as SQL projections from the ledger?
4. What retention period is required for deleted users, audit events, backup manifests, restore attempts, and sensitive borrower documents?
5. Should borrower documents be stored as encrypted SQLite blobs, encrypted private files referenced by SQLite, or external secure object storage?
6. What is the approved multi-device conflict rule when two devices post payments against the same loan while offline?
7. Which authenticated identity service will authorize Turso synchronization, and how will tenant/business isolation be enforced server-side?
8. Where will the database encryption key and backup-encryption recovery key be escrowed so reinstall/device loss remains recoverable without embedding secrets in the app?
9. Which web SQLite runtime is approved: OPFS-backed SQLite, wa-sqlite, or another implementation with transactional durability and browser support guarantees?
10. Are legacy IDs globally unique across customers, loans, payments, areas, devices, and restored backups, or must migration namespace collisions while preserving the original ID?
11. Which timezone owns business dates and collection-day boundaries when the device timezone differs from the configured business timezone?
12. Must historical borrower/contact/area snapshots remain exactly as posted, or may reports deliberately join to current master data for selected views?

Until these are approved, migration design uses conservative defaults: preserve both conflicting values, classify differences as blocking reconciliation items where financial totals are affected, retain original snapshots, and never discard a record.

## 15. Approval checklist

Implementation should not begin until these decisions are confirmed:

1. Whether historical plaintext user PINs should force a reset or be one-time hashed during migration.
2. The exact legal/business meaning of `openingPaid`: prior principal payment, opening receivable adjustment, or both depending on legacy loan type.
3. The authoritative interest basis for each legacy loan type and version.
4. Whether “manual reopen” reactivates the same contract or must always create a linked new loan.
5. Required audit retention period and encryption/key-management policy.
6. Turso access architecture: backend gateway or short-lived scoped token issuer.

Until these decisions and all critical migration gates are satisfied, the existing app must remain the active system and the SQLite candidate must be treated as read-only test output.

## Appendix A. Exhaustive legacy property catalog

This catalog is the union of persisted object literals, backup aliases, restore normalizers and financial/scheduler references found in the audited `index.html`. DOM-only properties and standard Error/Event methods found by lexical search are excluded.

### Customer properties

`id`, `customerId`, `custNo`, `name`, `phone`, `phone2`, `phoneClean`, `area`, `areaId`, `kycNo`, `matchKey`, `address`, `location`, `lat`, `lng`, `createdAt`, `updatedAt`.

### Loan-profile/borrower properties

`id`, `loanProfileId`, `borrowerId`, `profileType`, `customerId`, `custId`, `custNo`, `claimId`, `name`, `phone`, `phone2`, `address`, `lat`, `lng`, `area`, `areaId`, `guarantorId`, `agent`, `loanno`, `loanType`, `isInterest`, `period`, `loan`, `principalAmt`, `originalLoanAmount`, `baseLoanAmount`, `originalPrincipal`, `prev`, `openingPrev`, `openingPaidAmount`, `originalOpeningPaid`, `openingPaidDate`, `openingPaidDateMigration`, `remainingPrincipal`, `loandate`, `loanStartDate`, `originalLoanDate`, `loanend`, `loanEnd`, `interestRate`, `interestAmt`, `interestAmount`, `interestCalcStart`, `interestBasePrincipalAtStart`, `interestCredit`, `prevPendingInterest`, `previousPending`, `pendingAmount`, `dueAmount`, `billingAmt`, `manualPay`, `docFee`, `commission`, `commissionSet`, `commissionNo`, `loanPayType`, `loanIssueCashAmt`, `loanIssueUpiAmt`, `loanIssueIsSplit`, `loanSecurityType`, `loanDocuments`, `topups`, `topupHistory`, `completed`, `completedDate`, `closed`, `closedDate`, `paidOff`, `permanentClosed`, `finalClosed`, `closureLocked`, `closureType`, `status`, `loanStatus`, `collectionDone`, `ignored`, `nextDueDate`, `nextDueDateStr`, `nextCollectionDate`, `nextCollection`, `scheduledDateTime`, `monthlyCycleStatus`, `monthlyNextWeekClickCount`, `_closedTabDate`, `_nextWeekAnchorDate`, `_reopenForceActive`, `autoReopenDate`, `autoReopenNextDue`, `reminderSnoozed`, `lastCollectionCycleDate`, `lastInterestPending`, `lastInterestDiscount`, `lastInterestBalanceChoice`, `lastInterestBalanceDate`, `otsFromBid`, `otsFromLoanno`, `otsOldBalance`, `otsPrincipalBalance`, `otsCurrentDue`, `otsPreviousPending`, `totalClosureAmount`, `otsPaidToday`, `otsAdjustedBalance`, `otsBalanceWrittenOff`, `otsPayVal`, `otsCashAmt`, `otsUpiAmt`, `otsUpiMethod`, `otsIsSplit`, `otsDateVal`, `otsNewLoanAmt`, `otsInterestAmt`, `otsNetLoanAmt`, `otsDocFee`, `otsCashOnHand`, `otsOriginalLoanType`, `otsIsInterestLoan`, `isOTSNewLoan`, `otsClearedDate`, `otsNewLoanId`, `otsNewLoanno`, `showSuccessPopup`, `collectionSuccessPopup`, `_autoCalcBilling`, `_autoCalcManual`, `createdAt`, `updatedAt`.

### History/payment/event properties

`id`, `bid`, `borrowerId`, `loanId`, `loanProfileId`, `customerId`, `name`, `phone`, `area`, `areaId`, `mainArea`, `reportArea`, `loanAmt`, `loanDate`, `loanno`, `date`, `paymentDate`, `paidDate`, `ts`, `createdAt`, `updatedAt`, `today`, `paidAmount`, `amount`, `total`, `balance`, `principalComponent`, `interestComponent`, `prevPrincipal`, `pay`, `bank`, `cashAmt`, `upiAmt`, `upiMethod`, `isSplit`, `paymentPurpose`, `entryType`, `eventType`, `note`, `remarks`, `collectionCategory`, `agentCategory`, `agentRemark`, `agentSource`, `cyclePeriodStart`, `cyclePeriodEnd`, `cycleInterest`, `cyclePayments`, `paidCycleCount`, `pendingCycleCount`, `pendingCycleAmount`, `previousPending`, `prevPendingArrearPaid`, `totalClosureAmount`, `closureDiscountAdjustment`, `totalDueAtPayment`, `remainingPending`, `payableAmt`, `dueDate`, `dueDiscount`, `interestBalanceChoice`, `interestPendingSaved`, `interestCredit`, `preClosureDate`, `preClosureDue`, `preClosurePendingCyclesDue`, `preClosurePreviousPending`, `preClosureUsedDays`, `preClosureTotalDays`, `preClosurePerDay`, `preClosureRunCycleStart`, `preClosureRunCycleEnd`, `isOpeningBalance`, `isOpeningPaid`, `openingPaidAmount`, `openingPaidDate`, `openingPaidDateMigration`, `legacyOpeningPaidDate`, `originalOpeningPaid`, `originalLoanDate`, `isProtected`, `protected`, `locked`, `isLocked`, `immutable`, `canEdit`, `canDelete`, `isOpeningPaidDuplicate`, `supersededByOpeningPaidId`, `balanceNeutral`, `isTopUp`, `topupId`, `topupAmount`, `topupInterest`, `topupAmtType`, `interestCalcStart`, `interestBasePrincipalAtStart`, `isLoanClosure`, `isFullClose`, `isFullPaid`, `isPaidOff`, `isDiscountClosure`, `interestReduceAmt`, `finalClosureAmt`, `isOTS`, `isOTSPayment`, `isOTSBalAdj`, `otsOldBalance`, `otsPaidToday`, `otsAdjustedBalance`, `otsBalanceWrittenOff`, `otsLoanCleared`, `otsNewLoanAmt`, `otsInterestAmt`, `otsNetLoanAmt`, `otsDocFee`, `otsCashOnHand`, `isNpaMove`, `fromLoanType`, `isReopened`, `reopenedDate`, `reopenedBy`, `reopenReason`, `restoredBalance`, `isLoanCreation`.

### Area, expense, non-account, cashbook and reminder properties

- Area: `id/areaId`, `name`, `day`, `areaType`, `parentArea`, `parentAreaId`, `subAreas`.
- Expense: `id`, `date`, `area`, `areaId`, `mainArea`, `mainAreaId`, `name`, `amount`, `mode`, `category`, `note`.
- Non-account transaction: `id`, `date`, `ts`, `type`, `amount`, `name`, `bid`, `area`, `areaId`, `mainArea`, `mainAreaId`, `pay`, `note`.
- Cashbook: business date key, `areas`, `openBal`, `closeBal`, `cashTxnBalance`, `updatedAt`.
- Reminder: `id`, `bid`, `name`, `area`, `phone`, `datetime`, `displayDate`, `note`, `type`, `loanno`, `balance`.
- UPI: `id`, `label`, `vpa`, `icon` and QR-derived payload/settings.

### Settings and security properties

`company`, `agent`, `phone`, `area`, `pay`, `weekly_period`, `monthly_period`, `payamt`, `week_start`, `default_loan_type`, `interest_weekly`, `interest_monthly`, `billing_pct`, `interest_calc_type`, `smart_agent`, `collection_success_popup`, `backup_safety_check`, `whatsapp_path`, auto-sync, app-lock `enabled`, `biometric`, `pinHash`, `patternHash`, `salt`, message templates/history, smart-agent history, license/device/install data and Google OAuth client ID.

User management additionally uses `userId`, `username`, `name`, `mobile`, `deviceId`, `role`, `status`, `pin`, `createdAt`, `createdBy`, `updatedAt`; sessions use `userId`, `loginTime`, `deviceId`; audit uses `id`, `ts`, `userId`, `username`, `name`, `deviceId`, `action`, `txnType`, `custName`, `amount`, `note`, `syncTime`.

### Backup/restore properties

`version`, `backupVersion`, `schemaVersion`, `appVersion`, `exportedAt`, `app`, `customers`, `borrowers`, `loanProfiles`, `entryLog`, `history`, `historyTab`, `paymentHistory`, `openingPaidEntries`, `borrowerWisePaymentHistory`, `paymentHistoryByBorrower`, `areas`, `nonAccTxns`, `upiIds`, `expenses`, `cashbook`, `reminders`, `settings`, `legacyRecords`, `migration`, `retiredAreaIds`, `collReports`, `reports`, `integrity`, `backupMetadata`, record counts, byte size, SHA-256, storage space, Drive file/revision IDs and timestamps, encrypted full/incremental manifest, sequence, row version/checksum, resumable session/offset, retry state, restore staging metadata and before/incoming/after validation summaries.

## Appendix B. Audit evidence anchors

- IndexedDB/localStorage wrapper, checkpoints and backup migration: `www/index.html` lines 78-960.
- Primary state arrays and save/load paths: `www/index.html` lines 7320-7735.
- Canonical/current balance helpers: `www/index.html` lines 8030-8250.
- Customer/loan creation and opening-paid row creation: `www/index.html` lines 12640-12740 and 14580-14710.
- Payment creation and closure snapshots: `www/index.html` around lines 27180-27420.
- Historical recalculation and destructive payment edit/delete: `www/index.html` lines 18000-18490.
- Top-up creation/edit/delete: `www/index.html` lines 19530-19935.
- Cashbook and expenses: `www/index.html` lines 22280-22480.
- Collection-report formulas/cache: `www/index.html` lines 25330-25580.
- Reminders and scheduler coupling: `www/index.html` lines 26040-26220.
- User/session/audit localStorage: `www/index.html` lines 30520-31080.
- Android backup/Drive staging and SharedPreferences bridges: `android/app/src/main/java/in/vasoolbook/app/MainActivity.java`.
