-- Tenant subscription / billing information
-- Managed by admin; displayed to owners when show_billing_portal = true

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  -- Plan details
  plan_name         TEXT NOT NULL DEFAULT 'Starter',
  price_cents       INTEGER NOT NULL DEFAULT 0,          -- price in cents (e.g. 4900 = $49.00)
  currency          TEXT NOT NULL DEFAULT 'usd',
  billing_frequency TEXT NOT NULL DEFAULT 'monthly',     -- monthly | quarterly | yearly | one_time
  status            TEXT NOT NULL DEFAULT 'trial',       -- trial | active | past_due | cancelled | paused

  -- Payment method (last-4 + brand stored for display; no full card data)
  payment_method_brand  TEXT,                            -- visa, mastercard, amex, etc.
  payment_method_last4  TEXT,                            -- e.g. "4242"

  -- Billing dates
  trial_ends_at         TIMESTAMPTZ,
  next_billing_date     TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,

  -- Admin toggle: show/hide the billing section on the owner portal
  show_billing_portal   BOOLEAN NOT NULL DEFAULT true,

  -- Notes (admin-only, e.g. "Comp'd for beta", "Invoice #1234")
  admin_notes           TEXT,

  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
