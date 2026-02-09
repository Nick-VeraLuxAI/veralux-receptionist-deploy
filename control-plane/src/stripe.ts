/**
 * Stripe integration service.
 *
 * Handles:
 *  - Customer creation/lookup (linked to tenant)
 *  - Checkout session creation (owner subscribes to a plan)
 *  - Customer portal session (owner manages payment methods / cancels)
 *  - Webhook processing (keeps tenant_subscriptions in sync)
 *  - Admin helpers (create products/prices, list plans)
 */

import Stripe from "stripe";
import { pool } from "./db";
import type { TenantSubscription } from "./db";

// ── Stripe client singleton ─────────────────────

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key);
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// ── Customers ───────────────────────────────────

export async function getOrCreateStripeCustomer(
  tenantId: string,
  opts?: { email?: string; name?: string }
): Promise<string> {
  const client = await pool.connect();
  try {
    // Check if we already have a customer
    const existing = await client.query(
      "SELECT stripe_customer_id FROM tenant_subscriptions WHERE tenant_id = $1",
      [tenantId]
    );
    if (existing.rows[0]?.stripe_customer_id) {
      return existing.rows[0].stripe_customer_id;
    }

    // Create in Stripe
    const stripe = getStripe();
    const customer = await stripe.customers.create({
      metadata: { tenant_id: tenantId },
      email: opts?.email,
      name: opts?.name || tenantId,
    });

    // Store the ID
    await client.query(
      `INSERT INTO tenant_subscriptions (tenant_id, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET stripe_customer_id = $2, updated_at = now()`,
      [tenantId, customer.id]
    );

    return customer.id;
  } finally {
    client.release();
  }
}

// ── Checkout Sessions ───────────────────────────

export async function createCheckoutSession(params: {
  tenantId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantName?: string;
  tenantEmail?: string;
}): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(params.tenantId, {
    name: params.tenantName,
    email: params.tenantEmail,
  });

  // Look up the price to determine if it's recurring or one-time
  const priceObj = await stripe.prices.retrieve(params.priceId);
  const isOneTime = !priceObj.recurring;

  if (isOneTime) {
    return stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: { tenant_id: params.tenantId },
    });
  }

  return stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { tenant_id: params.tenantId },
    subscription_data: {
      metadata: { tenant_id: params.tenantId },
    },
  });
}

// ── Customer Portal ─────────────────────────────

export async function createPortalSession(params: {
  tenantId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(params.tenantId);

  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: params.returnUrl,
  });
}

// ── Webhook Processing ──────────────────────────

export async function handleStripeWebhook(
  body: Buffer,
  signature: string
): Promise<{ event: string; tenantId?: string }> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");

  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  const client = await pool.connect();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenant_id;
        if (tenantId && session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          await client.query(
            `UPDATE tenant_subscriptions
             SET stripe_subscription_id = $2, status = 'active', updated_at = now()
             WHERE tenant_id = $1`,
            [tenantId, subId]
          );
          // Fetch full subscription to get price/period details
          await syncSubscriptionFromStripe(tenantId, subId);
        }
        return { event: event.type, tenantId };
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id;
        if (customerId) {
          await client.query(
            `UPDATE tenant_subscriptions
             SET status = 'active', updated_at = now()
             WHERE stripe_customer_id = $1`,
            [customerId]
          );
          const row = await client.query(
            "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_customer_id = $1",
            [customerId]
          );
          return { event: event.type, tenantId: row.rows[0]?.tenant_id };
        }
        return { event: event.type };
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id;
        if (customerId) {
          await client.query(
            `UPDATE tenant_subscriptions
             SET status = 'past_due', updated_at = now()
             WHERE stripe_customer_id = $1`,
            [customerId]
          );
          const row = await client.query(
            "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_customer_id = $1",
            [customerId]
          );
          return { event: event.type, tenantId: row.rows[0]?.tenant_id };
        }
        return { event: event.type };
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const tenantId = sub.metadata?.tenant_id;
        if (tenantId) {
          await syncSubscriptionFromStripe(tenantId, sub.id);
        } else {
          // Try to find by customer ID
          const customerId = typeof sub.customer === "string"
            ? sub.customer
            : sub.customer.id;
          const row = await client.query(
            "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_customer_id = $1",
            [customerId]
          );
          if (row.rows[0]) {
            await syncSubscriptionFromStripe(row.rows[0].tenant_id, sub.id);
          }
        }
        return { event: event.type, tenantId };
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string"
          ? sub.customer
          : sub.customer.id;
        await client.query(
          `UPDATE tenant_subscriptions
           SET status = 'cancelled', cancelled_at = now(), updated_at = now()
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
        const row = await client.query(
          "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_customer_id = $1",
          [customerId]
        );
        return { event: event.type, tenantId: row.rows[0]?.tenant_id };
      }

      default:
        return { event: event.type };
    }
  } finally {
    client.release();
  }
}

// ── Sync helper ─────────────────────────────────

export async function syncSubscriptionFromStripe(
  tenantId: string,
  stripeSubId: string
): Promise<void> {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["default_payment_method", "items.data.price"],
  });

  const item = sub.items.data[0];
  const price = item?.price;

  const statusMap: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    cancelled: "cancelled",
    trialing: "trial",
    unpaid: "past_due",
    paused: "paused",
    incomplete: "trial",
    incomplete_expired: "cancelled",
  };

  const billingMap: Record<string, string> = {
    month: "monthly",
    quarter: "quarterly",
    year: "yearly",
  };

  let cardBrand: string | null = null;
  let cardLast4: string | null = null;
  let paymentMethodId: string | null = null;

  if (sub.default_payment_method && typeof sub.default_payment_method !== "string") {
    const pm = sub.default_payment_method;
    paymentMethodId = pm.id;
    if (pm.card) {
      cardBrand = pm.card.brand;
      cardLast4 = pm.card.last4;
    }
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE tenant_subscriptions SET
        stripe_subscription_id = $2,
        stripe_price_id = $3,
        stripe_product_id = $4,
        stripe_payment_method_id = $5,
        plan_name = COALESCE($6, plan_name),
        price_cents = COALESCE($7, price_cents),
        currency = COALESCE($8, currency),
        billing_frequency = COALESCE($9, billing_frequency),
        status = COALESCE($10, status),
        payment_method_brand = COALESCE($11, payment_method_brand),
        payment_method_last4 = COALESCE($12, payment_method_last4),
        next_billing_date = $13,
        trial_ends_at = $14,
        cancelled_at = $15,
        updated_at = now()
      WHERE tenant_id = $1`,
      [
        tenantId,
        sub.id,
        price?.id ?? null,
        (typeof price?.product === "string" ? price.product : price?.product?.id) ?? null,
        paymentMethodId,
        price?.nickname || null,
        price?.unit_amount ?? null,
        price?.currency ?? null,
        billingMap[price?.recurring?.interval ?? ""] ?? null,
        statusMap[sub.status] ?? sub.status,
        cardBrand,
        cardLast4,
        (sub as any).current_period_end ? new Date((sub as any).current_period_end * 1000).toISOString() : null,
        (sub as any).trial_end ? new Date((sub as any).trial_end * 1000).toISOString() : null,
        (sub as any).canceled_at ? new Date((sub as any).canceled_at * 1000).toISOString() : null,
      ]
    );
  } finally {
    client.release();
  }
}

// ── Admin: list Stripe plans ────────────────────

export async function listStripePlans(): Promise<any[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM stripe_plans WHERE active = true ORDER BY price_cents ASC"
    );
    return res.rows;
  } finally {
    client.release();
  }
}

export async function createStripePlan(params: {
  name: string;
  priceCents: number;
  currency?: string;
  billingInterval?: string;
}): Promise<any> {
  const stripe = getStripe();

  // Create product + price in Stripe
  const product = await stripe.products.create({
    name: params.name,
    metadata: { source: "veralux_admin" },
  });

  const isOneTime = params.billingInterval === "one_time";

  let price: Stripe.Price;

  if (isOneTime) {
    // One-time payment — no recurring
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: params.priceCents,
      currency: params.currency || "usd",
    });
  } else {
    const intervalMap: Record<string, Stripe.PriceCreateParams.Recurring.Interval> = {
      month: "month",
      monthly: "month",
      quarter: "month", // We'll use interval_count=3
      quarterly: "month",
      year: "year",
      yearly: "year",
    };

    const interval = intervalMap[params.billingInterval || "month"] || "month";
    const intervalCount = (params.billingInterval === "quarter" || params.billingInterval === "quarterly") ? 3 : 1;

    price = await stripe.prices.create({
      product: product.id,
      unit_amount: params.priceCents,
      currency: params.currency || "usd",
      recurring: { interval, interval_count: intervalCount },
    });
  }

  // Save locally
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO stripe_plans (name, stripe_product_id, stripe_price_id, price_cents, currency, billing_interval, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [params.name, product.id, price.id, params.priceCents, params.currency || "usd", params.billingInterval || "month"]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function deleteStripePlan(planId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    // Get the plan first so we can deactivate in Stripe
    const existing = await client.query(
      "SELECT * FROM stripe_plans WHERE id = $1",
      [planId]
    );
    if (!existing.rows[0]) return false;

    const plan = existing.rows[0];

    // Deactivate the price and archive the product in Stripe
    const stripe = getStripe();
    if (plan.stripe_price_id) {
      await stripe.prices.update(plan.stripe_price_id, { active: false }).catch(() => {});
    }
    if (plan.stripe_product_id) {
      await stripe.products.update(plan.stripe_product_id, { active: false }).catch(() => {});
    }

    // Mark as inactive locally (soft delete)
    await client.query(
      "UPDATE stripe_plans SET active = false WHERE id = $1",
      [planId]
    );

    // Clear subscription info for any tenants referencing this plan's price
    if (plan.stripe_price_id) {
      await client.query(
        `UPDATE tenant_subscriptions
         SET stripe_price_id = NULL,
             stripe_product_id = NULL,
             plan_name = NULL,
             price_cents = NULL,
             billing_frequency = NULL,
             status = 'cancelled'
         WHERE stripe_price_id = $1`,
        [plan.stripe_price_id]
      );
    }

    return true;
  } finally {
    client.release();
  }
}
