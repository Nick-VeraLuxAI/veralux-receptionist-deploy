-- Owner authentication: passcode-based login for business owners
-- Each tenant can have an owner passcode for portal access

CREATE TABLE IF NOT EXISTS owner_passcodes (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  passcode_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
