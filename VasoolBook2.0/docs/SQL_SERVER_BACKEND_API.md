# VasoolBook SQL Backend API Contract

The Android/WebView client never connects directly to Turso, Firebase Admin,
PostgreSQL, MySQL, Microsoft SQL Server, or another database. The configured URL must be
an HTTPS backend controlled by the application owner. Database passwords and
provider administrative tokens belong only in that backend's secret manager.

Supported client provider modes are `turso`, `firebase`, and `custom`, plus
the retained VasoolBook/PostgreSQL/MySQL/MSSQL gateway modes. For Turso, the
client may send the non-secret `libsql://` database URL as the database
identifier, but the Turso authentication token remains server-side. For
Firebase, the client may send a short-lived signed-in user ID token; Firebase
service-account JSON and Admin SDK credentials remain server-side.

## Authentication

The client sends its scoped application token as:

```http
Authorization: Bearer <scoped-user-token>
X-VasoolBook-Protocol: 1
X-VasoolBook-Provider: postgres
X-VasoolBook-Database: vasoolbook
X-VasoolBook-Username: optional-user
X-VasoolBook-Connection: turso-a1b2c3d4
X-VasoolBook-Auth-Mode: scoped-gateway-token
```

The token must authorize only the selected business/database. It must not be a
database administrator password. The backend must enforce tenant isolation,
rate limits, token expiry, audit logging, and HTTPS.

## Endpoints

### `POST /v1/sql/connect`

Validates the token, tenant, provider and database. Return:

```json
{
  "ok": true,
  "message": "Connected",
  "serverRevision": "42"
}
```

### `GET /v1/sql/health`

Tests API/database reachability and schema integrity.

```json
{
  "ok": true,
  "integrity": { "valid": true },
  "serverRevision": "42"
}
```

### `POST /v1/sql/sync`

The request contains a validated full VasoolBook snapshot, SHA-256 checksum,
record-count summary, dataset manifest, base revision and idempotency key.

The backend must:

1. Authenticate and authorize the selected tenant.
2. Reject a stale `If-Match`/`baseRevision` with HTTP 409.
3. Deduplicate `X-Idempotency-Key`.
4. Validate checksum, schema, relationships and financial totals.
5. Stage all changes in a database transaction.
6. Detect same-ID financial conflicts before commit.
7. Commit once or roll back completely.
8. Return the acknowledged data checksum and new revision.

```json
{
  "ok": true,
  "acceptedDataChecksum": "<request dataChecksum>",
  "serverRevision": "43",
  "integrity": { "valid": true },
  "snapshotChecksum": "<optional merged snapshot checksum>",
  "snapshot": { "optional": "validated merged VasoolBook backup payload" }
}
```

Conflict response:

```json
{
  "ok": false,
  "code": "sync_conflict",
  "message": "Financial conflicts require review",
  "conflicts": [
    {
      "entity": "entryLog",
      "recordKey": "payment-id",
      "reason": "Same version with different amount"
    }
  ]
}
```

### `GET /v1/sql/status`

Returns revision, health, last successful sync and unresolved conflict count.

### `POST /v1/sql/backup`

Stores a separately versioned, validated backup. It receives the same
checksum, manifest, summary and immutable snapshot contract as sync. The
backend must deduplicate the idempotency key, verify the complete snapshot,
and return `acceptedDataChecksum`. It must never issue a destructive command
against the live client database.

### `GET /v1/sql/restore/preview`

Returns the selected verified backup without changing server or client data:

```json
{
  "ok": true,
  "snapshotChecksum": "<enterprise snapshot checksum>",
  "snapshot": { "backupVersion": 4, "schemaVersion": 7 }
}
```

The client validates and merges the snapshot in staging, displays a preview,
requires explicit confirmation, creates an emergency local snapshot, and
then uses the existing atomic restore transaction. Cancellation and all
validation failures are read-only.

### `POST /v1/sql/disconnect`

Revokes the current scoped token/session. Disconnect must never delete local or
server financial data.

## Database Rules

- Use UUID primary keys and foreign keys.
- Store money as integer paise.
- Keep payment and financial ledgers immutable.
- Record corrections as reversals/adjustments.
- Use soft deletion for financial records.
- Use a unique `(tenant_id, idempotency_key)` constraint.
- Use a unique `(tenant_id, entity_type, record_id, record_version)` constraint.
- Scope credentials, revisions, queues, and idempotency keys to the connection/tenant.
- Treat duplicate financial IDs with equal version/time but different values as conflicts.
- Never return provider administrator tokens, passwords, service-account keys, or client secrets.
- Apply each sync in one transaction with rollback on any validation failure.
- Never trust client totals without recalculating and comparing them.
- Preserve every prior valid revision in the audit log.
