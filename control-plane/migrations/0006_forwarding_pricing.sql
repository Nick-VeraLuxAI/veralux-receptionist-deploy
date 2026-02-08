-- LLM context: call forwarding profiles and pricing (per tenant)
alter table tenant_configs
  add column if not exists forwarding_profiles jsonb not null default '[]'::jsonb,
  add column if not exists pricing jsonb not null default '{"items":[],"notes":""}'::jsonb;

-- @down
alter table tenant_configs
  drop column if exists forwarding_profiles,
  drop column if exists pricing;
