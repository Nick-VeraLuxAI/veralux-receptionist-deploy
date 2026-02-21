-- Per-tenant usage metering table for billing enforcement
CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period text NOT NULL, -- YYYY-MM format
  call_count integer NOT NULL DEFAULT 0,
  call_minutes integer NOT NULL DEFAULT 0,
  api_requests integer NOT NULL DEFAULT 0,
  stt_minutes integer NOT NULL DEFAULT 0,
  tts_characters integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_period ON tenant_usage (period);

-- @down
DROP TABLE IF EXISTS tenant_usage;
