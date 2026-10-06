-- Call history: persists completed call records after they are removed from the active calls table.
CREATE TABLE IF NOT EXISTS call_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id         text,
  caller_id       text,
  stage           text,
  lead            jsonb NOT NULL DEFAULT '{}'::jsonb,
  history         jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript      text,
  summary         text,
  duration_ms     integer DEFAULT 0,
  started_at      timestamptz DEFAULT now(),
  ended_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_history_tenant ON call_history (tenant_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_caller ON call_history (caller_id, ended_at DESC);
