-- Add Stripe integration fields to tenant_subscriptions

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_customer_id    TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id       TEXT,
  ADD COLUMN IF NOT EXISTS stripe_product_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;

-- Index for quick lookups by Stripe customer ID (webhook resolution)
CREATE INDEX IF NOT EXISTS idx_sub_stripe_customer
  ON tenant_subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Table to store Stripe products/prices created by admin
CREATE TABLE IF NOT EXISTS stripe_plans (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  stripe_product_id TEXT,
  stripe_price_id   TEXT,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'usd',
  billing_interval TEXT NOT NULL DEFAULT 'month',  -- month | quarter | year
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);
