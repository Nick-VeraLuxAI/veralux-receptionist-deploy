-- Tenant branding: logo, colors, and company display name for documents/emails
alter table tenant_configs
  add column if not exists branding jsonb not null default '{}'::jsonb;

-- @down
alter table tenant_configs
  drop column if exists branding;
