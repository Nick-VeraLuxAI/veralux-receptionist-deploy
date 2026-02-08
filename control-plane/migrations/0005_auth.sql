create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text,
  idp_sub text unique,
  created_at timestamptz default now()
);

create table if not exists tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null,
  created_at timestamptz default now(),
  unique (tenant_id, user_id)
);
create index if not exists idx_memberships_tenant_user on tenant_memberships (tenant_id, user_id);
create index if not exists idx_memberships_user on tenant_memberships (user_id);

create table if not exists tenant_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  key_hash text not null,
  scopes text,
  created_at timestamptz default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index if not exists idx_tenant_api_keys_tenant on tenant_api_keys (tenant_id);
create index if not exists idx_tenant_api_keys_hash on tenant_api_keys (key_hash);

-- @down
drop table if exists tenant_api_keys;
drop table if exists tenant_memberships;
drop table if exists users;
