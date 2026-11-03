-- Apply with a migration principal before enabling webhook ingress.
CREATE TABLE IF NOT EXISTS patchwork_webhook_inbox (
  delivery_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS patchwork_webhook_claim ON patchwork_webhook_inbox(status,available_at);
CREATE INDEX IF NOT EXISTS patchwork_webhook_expiry ON patchwork_webhook_inbox(expires_at);
CREATE TABLE IF NOT EXISTS patchwork_refresh_state (
  owner_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  revision BIGINT NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner_id,repository)
);
