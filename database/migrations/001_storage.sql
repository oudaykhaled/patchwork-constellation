-- Idempotent MVP persistence schema. Run with a migration principal; production
-- serving principal only needs SELECT/INSERT/UPDATE/DELETE on these tables.
CREATE TABLE IF NOT EXISTS patchwork_snapshots (
  owner_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, repository, id)
);
-- Existing installations predate incremental refresh. Backfill a deterministic
-- tie-breakable write time; later writes always update it independently of reads.
ALTER TABLE patchwork_snapshots ADD COLUMN IF NOT EXISTS stored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS patchwork_snapshots_expiry ON patchwork_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS patchwork_snapshots_latest ON patchwork_snapshots(owner_id, repository, stored_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS patchwork_jobs (
  owner_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','fetching','indexing','grouping','ready','partial','failed','cancelled')),
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, repository, id)
);
CREATE INDEX IF NOT EXISTS patchwork_jobs_claim ON patchwork_jobs(owner_id, repository, status, available_at);
CREATE INDEX IF NOT EXISTS patchwork_jobs_expiry ON patchwork_jobs(expires_at);

CREATE TABLE IF NOT EXISTS patchwork_webhook_deliveries (
  owner_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, repository, delivery_id)
);
CREATE INDEX IF NOT EXISTS patchwork_deliveries_expiry ON patchwork_webhook_deliveries(expires_at);
