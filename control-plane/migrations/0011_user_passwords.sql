-- Add password_hash column to users table for email/password authentication
-- Used by the self-service tenant signup flow
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Unique index on email for login lookup (only for non-null emails)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email) WHERE email IS NOT NULL;

-- Pending invitations table (for adding users to tenants)
CREATE TABLE IF NOT EXISTS tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  invited_by uuid REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON tenant_invitations (email);
CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON tenant_invitations (tenant_id);

-- @down
DROP TABLE IF EXISTS tenant_invitations;
ALTER TABLE users DROP COLUMN IF EXISTS updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS name;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
DROP INDEX IF EXISTS idx_users_email_unique;
