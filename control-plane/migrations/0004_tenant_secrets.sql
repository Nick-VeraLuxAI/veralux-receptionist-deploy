create table if not exists tenant_secrets (
  tenant_id text not null references tenants(id) on delete cascade,
  key text not null,
  cipher text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (tenant_id, key)
);

create index if not exists idx_tenant_secrets_tenant on tenant_secrets (tenant_id);

-- @down
drop table if exists tenant_secrets;
