-- Workflow automation engine: definitions, execution log, and leads

-- Workflow definitions
CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  trigger_type    TEXT NOT NULL,  -- call_ended | after_hours_call | keyword_detected | missed_call | scheduled
  trigger_config  JSONB NOT NULL DEFAULT '{}',
  steps           JSONB NOT NULL DEFAULT '[]',  -- array of { action, config, order }
  created_by      TEXT NOT NULL DEFAULT 'admin',  -- admin | owner
  admin_locked    BOOLEAN NOT NULL DEFAULT false,  -- when true, owners cannot edit
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant
  ON workflows (tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflows_trigger
  ON workflows (tenant_id, trigger_type)
  WHERE enabled = true;

-- Workflow execution log
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  trigger_event   JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  steps_completed INTEGER NOT NULL DEFAULT 0,
  steps_total     INTEGER NOT NULL DEFAULT 0,
  result          JSONB NOT NULL DEFAULT '[]',  -- output from each step
  error           TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant
  ON workflow_runs (tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
  ON workflow_runs (workflow_id, started_at DESC);

-- Leads / contacts extracted from calls
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           TEXT,
  name              TEXT,
  phone             TEXT,
  email             TEXT,
  issue             TEXT,
  category          TEXT,
  priority          TEXT DEFAULT 'normal',
  notes             TEXT,
  raw_extract       JSONB,
  source_workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant
  ON leads (tenant_id, created_at DESC);

-- Workflow settings per tenant (stored in tenant_configs or separate table)
-- We add a column to tenant_configs for workflow settings
ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS workflow_settings JSONB NOT NULL DEFAULT '{"ownerCanEdit": false}';
