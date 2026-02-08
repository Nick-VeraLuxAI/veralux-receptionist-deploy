-- Tenants and routing
create table if not exists tenants (
  id text primary key,
  name text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists tenant_numbers (
  number text primary key,
  tenant_id text not null references tenants(id) on delete cascade
);

create index if not exists idx_tenant_numbers_tenant on tenant_numbers (tenant_id);

-- Configs (LLM/STT/TTS/prompts)
create table if not exists tenant_configs (
  tenant_id text primary key references tenants(id) on delete cascade,
  config jsonb not null,
  prompts jsonb not null,
  stt jsonb not null,
  tts jsonb not null,
  updated_at timestamptz default now()
);

-- Calls
create table if not exists calls (
  id uuid primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  caller_id text,
  stage text,
  lead jsonb not null default '{}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_calls_tenant on calls (tenant_id);
create index if not exists idx_calls_updated_at on calls (updated_at);

-- Analytics
create table if not exists analytics (
  tenant_id text primary key references tenants(id) on delete cascade,
  call_count integer not null default 0,
  caller_message_count integer not null default 0,
  question_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

create index if not exists idx_analytics_updated_at on analytics (updated_at);

-- @down
drop table if exists analytics;
drop table if exists calls;
drop table if exists tenant_configs;
drop table if exists tenant_numbers;
drop table if exists tenants;
