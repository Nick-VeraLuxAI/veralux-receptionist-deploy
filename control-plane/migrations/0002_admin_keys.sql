create extension if not exists pgcrypto;

-- Admin API keys (per-user)
create table if not exists admin_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'admin',
  token_hash text not null,
  created_at timestamptz default now(),
  last_used_at timestamptz
);

create unique index if not exists idx_admin_api_keys_hash on admin_api_keys (token_hash);
create index if not exists idx_admin_api_keys_role on admin_api_keys (role);

-- @down
drop table if exists admin_api_keys;
