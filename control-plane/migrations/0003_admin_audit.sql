-- Admin audit logs
create table if not exists admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_key_id uuid null references admin_api_keys(id) on delete set null,
  action text not null,
  path text,
  tenant_id text,
  status text,
  created_at timestamptz default now()
);

create index if not exists idx_admin_audit_created on admin_audit_logs (created_at desc);
create index if not exists idx_admin_audit_action on admin_audit_logs (action);

-- @down
drop table if exists admin_audit_logs;
