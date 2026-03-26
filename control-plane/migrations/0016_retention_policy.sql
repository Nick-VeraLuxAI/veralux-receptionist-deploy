-- Database retention policy: clean up old records to prevent unbounded growth.
-- Default retention: 90 days for transactional data.

-- Cleanup function: call periodically (daily via cron or at startup).
CREATE OR REPLACE FUNCTION cleanup_old_records(retention_days integer DEFAULT 90)
RETURNS TABLE(table_name text, rows_deleted bigint) AS $$
DECLARE
  cutoff timestamptz := now() - (retention_days || ' days')::interval;
  cnt bigint;
BEGIN
  -- Old call records
  DELETE FROM calls WHERE updated_at < cutoff;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'calls'; rows_deleted := cnt;
  RETURN NEXT;

  -- Old workflow runs (keep definitions, just prune execution history)
  DELETE FROM workflow_runs WHERE started_at < cutoff;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'workflow_runs'; rows_deleted := cnt;
  RETURN NEXT;

  -- Old audit log entries
  DELETE FROM admin_audit_logs WHERE created_at < cutoff;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'audit_log'; rows_deleted := cnt;
  RETURN NEXT;

  -- Expired password reset tokens
  DELETE FROM password_reset_tokens WHERE expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'password_reset_tokens'; rows_deleted := cnt;
  RETURN NEXT;

  -- Expired email verification tokens
  DELETE FROM email_verification_tokens WHERE expires_at < now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'email_verification_tokens'; rows_deleted := cnt;
  RETURN NEXT;

  -- Expired refresh tokens (older than 30 days regardless of retention setting)
  DELETE FROM refresh_tokens WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  table_name := 'refresh_tokens'; rows_deleted := cnt;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- @down (run manually to revert)
-- DROP FUNCTION IF EXISTS cleanup_old_records(integer);
