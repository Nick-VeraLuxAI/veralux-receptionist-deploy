import { Pool, type PoolClient } from "pg";
import fs from "fs";
import path from "path";

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://veralux:veralux@localhost:5432/veralux";

// Configurable pool settings via environment variables
const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || "10", 10);
const POOL_MIN = parseInt(process.env.DATABASE_POOL_MIN || "2", 10);
const POOL_IDLE_TIMEOUT = parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS || "30000", 10);
const POOL_CONNECTION_TIMEOUT = parseInt(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS || "5000", 10);

export const pool = new Pool({
  connectionString: DEFAULT_DATABASE_URL,
  max: POOL_MAX,
  min: POOL_MIN,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT,
});

// Log pool errors
pool.on("error", (err) => {
  console.error("[db] Pool error:", err.message);
});

/**
 * Helper to safely rollback and log failures
 */
async function safeRollback(client: PoolClient, context?: string): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackErr) {
    console.error("[db] Rollback failed", {
      context,
      error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
    });
  }
}

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const DOWN_MARKER = /^--\s*@down\b/im;
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );

function parseMigration(filePath: string): { up: string; down: string } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parts = raw.split(DOWN_MARKER);
  const up = parts[0].trim();
  const down = parts[1] ? parts[1].trim() : "";
  return { up, down };
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz default now()
    );
  `);
  const res = await client.query<{ id: string }>(
    "select id from schema_migrations order by id asc"
  );
  return new Set(res.rows.map((r: { id: string }) => r.id));
}

async function withDeadlockRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastErr = err;

      // Postgres deadlock detected
      const code = err?.code || err?.cause?.code;
      if (code !== "40P01") throw err;

      // small jitter backoff
      const delayMs = 20 * attempt + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}


export async function runMigrations(): Promise<void> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    const applied = await getAppliedMigrations(client);
    for (const file of files) {
      if (applied.has(file)) continue;
      const { up } = parseMigration(path.join(MIGRATIONS_DIR, file));
      if (!up) continue;
      await client.query("begin");
      await client.query(up);
      await client.query(
        "insert into schema_migrations (id, applied_at) values ($1, now())",
        [file]
      );
      await client.query("commit");
    }
  } catch (err) {
    await safeRollback(client, "runMigrations");
    throw err;
  } finally {
    client.release();
  }
}

export interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface BrandingConfig {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
}

export interface ConfigRow {
  tenant_id: string;
  config: unknown;
  prompts: unknown;
  stt: unknown;
  tts: unknown;
  forwarding_profiles?: unknown;
  pricing?: unknown;
  branding?: BrandingConfig;
}

export interface CallRow {
  id: string;
  tenant_id: string;
  caller_id: string | null;
  stage: string | null;
  lead: any;
  history: any;
}

export interface AnalyticsRow {
  tenant_id: string;
  call_count: number;
  caller_message_count: number;
  question_counts: Record<string, number>;
}

export interface AdminApiKeyRow {
  id: string;
  name: string;
  role: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export interface SecretRow {
  tenant_id: string;
  key: string;
  cipher: string;
}

export interface UserRow {
  id: string;
  email: string | null;
  idp_sub: string | null;
}

export interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
}

export interface TenantApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  scopes: string | null;
  revoked_at: string | null;
}

export async function fetchTenantsFromDb(): Promise<{
  tenants: TenantRow[];
  numbers: { tenant_id: string; number: string }[];
  configs: ConfigRow[];
  calls: CallRow[];
  analytics: AnalyticsRow[];
  adminKeys: AdminApiKeyRow[];
  secrets: SecretRow[];
}> {
  const client = await pool.connect();
  try {
    const [tenants, numbers, configs, calls, analytics, adminKeys, secrets] =
      await Promise.all([
        client.query<TenantRow>("select * from tenants"),
        client.query<{ tenant_id: string; number: string }>(
          "select tenant_id, number from tenant_numbers"
        ),
        client.query<ConfigRow>("select * from tenant_configs"),
        client.query<CallRow>("select id, tenant_id, caller_id, stage, lead, history from calls"),
        client.query<AnalyticsRow>(
          "select tenant_id, call_count, caller_message_count, question_counts from analytics"
        ),
        client.query<AdminApiKeyRow>(
          "select id, name, role, token_hash, created_at, last_used_at from admin_api_keys"
        ),
        client.query<SecretRow>(
          "select tenant_id, key, cipher from tenant_secrets"
        ),
      ]);

    return {
      tenants: tenants.rows,
      numbers: numbers.rows,
      configs: configs.rows,
      calls: calls.rows,
      analytics: analytics.rows,
      adminKeys: adminKeys.rows,
      secrets: secrets.rows,
    };
  } finally {
    client.release();
  }
}

export async function upsertTenant(meta: {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenants (id, name, created_at, updated_at)
      values ($1, $2, to_timestamp($3/1000.0), to_timestamp($4/1000.0))
      on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
    `,
      [meta.id, meta.name, meta.createdAt || Date.now(), meta.updatedAt || Date.now()]
    );
  } finally {
    client.release();
  }
}

export async function setTenantNumbers(
  tenantId: string,
  numbers: string[]
): Promise<void> {
  const client = await pool.connect();
  try {
    const cleaned = Array.from(
      new Set(
        (numbers || [])
          .map((n) => String(n || "").trim())
          .filter(Boolean)
      )
    );

    await client.query("begin");

    // Remove all numbers currently attached to this tenant
    await client.query("delete from tenant_numbers where tenant_id = $1", [tenantId]);

    if (cleaned.length > 0) {
      // Guard: if any of these numbers belong to another tenant, fail cleanly.
      const conflict = await client.query<{ number: string; tenant_id: string }>(
        `
        select number, tenant_id
        from tenant_numbers
        where number = any($1::text[])
          and tenant_id <> $2
        `,
        [cleaned, tenantId]
      );

      if (conflict.rows.length > 0) {
        // rollback so we don't wipe this tenant's numbers then fail
        await client.query("rollback");

        const details = conflict.rows
          .map((r) => `${r.number} -> ${r.tenant_id}`)
          .join(", ");

        const err: any = new Error(`number_already_assigned: ${details}`);
        err.code = "NUMBER_ALREADY_ASSIGNED";
        throw err;
      }

      // Insert; if number already exists for SAME tenant (or was just inserted), no crash.
      const values = cleaned.map((_, idx) => `($1, $${idx + 2})`).join(",");
      await client.query(
        `
        insert into tenant_numbers (tenant_id, number)
        values ${values}
        on conflict (number) do update
          set tenant_id = excluded.tenant_id
        `,
        [tenantId, ...cleaned]
      );
    }

    await client.query("commit");
  } catch (err) {
    await safeRollback(client, "setTenantNumbers");
    throw err;
  } finally {
    client.release();
  }
}


export async function upsertConfig(row: ConfigRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenant_configs (tenant_id, config, prompts, stt, tts, forwarding_profiles, pricing, branding, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, now())
      on conflict (tenant_id) do update
      set config = excluded.config,
          prompts = excluded.prompts,
          stt = excluded.stt,
          tts = excluded.tts,
          forwarding_profiles = excluded.forwarding_profiles,
          pricing = excluded.pricing,
          branding = excluded.branding,
          updated_at = now()
    `,
      [
        row.tenant_id,
        row.config,
        row.prompts,
        row.stt,
        row.tts,
        row.forwarding_profiles ?? [],
        row.pricing ?? { items: [], notes: "" },
        row.branding ?? {},
      ]
    );
  } finally {
    client.release();
  }
}

export async function getBranding(tenantId: string): Promise<BrandingConfig> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ branding: BrandingConfig }>(
      "SELECT branding FROM tenant_configs WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0]?.branding ?? {};
  } finally {
    client.release();
  }
}

export async function upsertBranding(tenantId: string, branding: BrandingConfig): Promise<BrandingConfig> {
  const client = await pool.connect();
  try {
    // Merge with existing branding so partial updates work
    const res = await client.query<{ branding: BrandingConfig }>(
      `UPDATE tenant_configs
       SET branding = COALESCE(branding, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       WHERE tenant_id = $1
       RETURNING branding`,
      [tenantId, JSON.stringify(branding)]
    );
    return res.rows[0]?.branding ?? branding;
  } finally {
    client.release();
  }
}

export async function upsertCalls(
  tenantId: string,
  calls: CallRow[]
): Promise<void> {
  const invalid = calls.find((call) => !isUuid(call.id));
  if (invalid) {
    console.warn("[db] upsertCalls skipped invalid call id", {
      tenantId,
      callId: invalid.id,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from calls where tenant_id = $1", [tenantId]);
    for (const call of calls) {
      const leadJson = JSON.stringify(call.lead || {});
      const historyJson = JSON.stringify(call.history || []);
      await client.query(
        `
        insert into calls (id, tenant_id, caller_id, stage, lead, history, created_at, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), now())
        on conflict (id) do update
        set caller_id = excluded.caller_id,
            stage = excluded.stage,
            lead = excluded.lead,
            history = excluded.history,
            updated_at = now()
      `,
        [
          call.id,
          tenantId,
          call.caller_id,
          call.stage,
          leadJson,
          historyJson,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client, "upsertCalls");
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertAnalyticsRow(row: AnalyticsRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into analytics (tenant_id, call_count, caller_message_count, question_counts, updated_at)
      values ($1, $2, $3, $4::jsonb, now())
      on conflict (tenant_id) do update
      set call_count = excluded.call_count,
          caller_message_count = excluded.caller_message_count,
          question_counts = excluded.question_counts,
          updated_at = now()
    `,
      [
        row.tenant_id,
        row.call_count,
        row.caller_message_count,
        JSON.stringify(row.question_counts || {}),
      ]
    );
  } finally {
    client.release();
  }
}

export async function insertAdminKey(params: {
  name: string;
  role: string;
  tokenHash: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string }>(
      `
      insert into admin_api_keys (name, role, token_hash)
      values ($1, $2, $3)
      returning id
    `,
      [params.name, params.role, params.tokenHash]
    );
    return res.rows[0].id;
  } finally {
    client.release();
  }
}

export async function findAdminKeyByHash(
  tokenHash: string
): Promise<AdminApiKeyRow | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query<AdminApiKeyRow>(
      "select id, name, role, token_hash, created_at, last_used_at from admin_api_keys where token_hash = $1",
      [tokenHash]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function listAdminKeys(): Promise<AdminApiKeyRow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query<AdminApiKeyRow>(
      "select id, name, role, created_at, last_used_at from admin_api_keys order by created_at desc"
    );
    return res.rows;
  } finally {
    client.release();
  }
}

export async function deleteAdminKey(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("delete from admin_api_keys where id = $1", [id]);
  } finally {
    client.release();
  }
}

export async function touchAdminKeyUsage(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "update admin_api_keys set last_used_at = now() where id = $1",
      [id]
    );
  } finally {
    client.release();
  }
}

export async function insertAuditLog(params: {
  adminKeyId?: string;
  action: string;
  path?: string;
  tenantId?: string;
  status?: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into admin_audit_logs (admin_key_id, action, path, tenant_id, status)
      values ($1, $2, $3, $4, $5)
    `,
      [
        params.adminKeyId || null,
        params.action,
        params.path || null,
        params.tenantId || null,
        params.status || null,
      ]
    );
  } finally {
    client.release();
  }
}

export async function listAuditLogs(limit = 50): Promise<
  {
    id: string;
    admin_key_id: string | null;
    action: string;
    path: string | null;
    tenant_id: string | null;
    status: string | null;
    created_at: string;
  }[]
> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `select id, admin_key_id, action, path, tenant_id, status, created_at
       from admin_audit_logs
       order by created_at desc
       limit $1`,
      [limit]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

export async function upsertSecretRow(row: {
  tenantId: string;
  key: string;
  cipher: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenant_secrets (tenant_id, key, cipher, created_at, updated_at)
      values ($1, $2, $3, now(), now())
      on conflict (tenant_id, key) do update
      set cipher = excluded.cipher,
          updated_at = now()
    `,
      [row.tenantId, row.key, row.cipher]
    );
  } finally {
    client.release();
  }
}

export async function getSecretRow(
  tenantId: string,
  key: string
): Promise<SecretRow | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query<SecretRow>(
      "select tenant_id, key, cipher from tenant_secrets where tenant_id = $1 and key = $2",
      [tenantId, key]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function deleteSecretRow(tenantId: string, key: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("delete from tenant_secrets where tenant_id = $1 and key = $2", [
      tenantId,
      key,
    ]);
  } finally {
    client.release();
  }
}

export async function upsertUserBySub(params: {
  idpSub: string;
  email?: string | null;
}): Promise<UserRow> {
  const idpSub = String(params.idpSub || "").trim();
  if (!idpSub) throw new Error("upsertUserBySub: idpSub required");

  const email =
    params.email === undefined
      ? null
      : params.email
      ? String(params.email).trim()
      : null;

  const client = await pool.connect();
  try {
    // IMPORTANT:
    // - Do NOT insert into users.id (uuid). Let DB generate it (or keep existing).
    // - Use idp_sub (text/unique) as the natural key for upsert.
    const res = await client.query<UserRow>(
      `
      insert into users (email, idp_sub)
      values ($1, $2)
      on conflict (idp_sub) do update
        set email = coalesce(excluded.email, users.email)
      returning id, email, idp_sub
      `,
      [email, idpSub]
    );

    return res.rows[0];
  } finally {
    client.release();
  }
}


export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const uid = String(userId || "").trim();
  if (!uid) return [];

  const client = await pool.connect();
  try {
    const res = await client.query<MembershipRow>(
      "select id, tenant_id, user_id, role from tenant_memberships where user_id = $1",
      [uid]
    );
    return res.rows;
  } finally {
    client.release();
  }
}


// ── Owner passcode helpers ─────────────────────────

export async function upsertOwnerPasscode(tenantId: string, passcodeHash: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO owner_passcodes (tenant_id, passcode_hash, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET passcode_hash = $2, updated_at = now()`,
      [tenantId, passcodeHash]
    );
  } finally {
    client.release();
  }
}

export async function getOwnerPasscodeHash(tenantId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ passcode_hash: string }>(
      "SELECT passcode_hash FROM owner_passcodes WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0]?.passcode_hash ?? null;
  } finally {
    client.release();
  }
}

export async function upsertTenantMembership(params: {
  tenantId: string;
  userId: string;
  role: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET role = $3`,
      [params.tenantId, params.userId, params.role]
    );
  } finally {
    client.release();
  }
}

// ── Subscription helpers ──────────────────────────

export interface TenantSubscription {
  tenantId: string;
  planName: string;
  priceCents: number;
  currency: string;
  billingFrequency: string;
  status: string;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  trialEndsAt: string | null;
  nextBillingDate: string | null;
  cancelledAt: string | null;
  showBillingPortal: boolean;
  adminNotes: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeProductId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToSubscription(row: any): TenantSubscription {
  return {
    tenantId: row.tenant_id,
    planName: row.plan_name,
    priceCents: row.price_cents,
    currency: row.currency,
    billingFrequency: row.billing_frequency,
    status: row.status,
    paymentMethodBrand: row.payment_method_brand,
    paymentMethodLast4: row.payment_method_last4,
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    nextBillingDate: row.next_billing_date?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    showBillingPortal: row.show_billing_portal,
    adminNotes: row.admin_notes,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    stripeProductId: row.stripe_product_id ?? null,
    createdAt: row.created_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
  };
}

export async function getSubscription(tenantId: string): Promise<TenantSubscription | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM tenant_subscriptions WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0] ? rowToSubscription(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function upsertSubscription(
  tenantId: string,
  data: Partial<Omit<TenantSubscription, "tenantId" | "createdAt" | "updatedAt">>
): Promise<TenantSubscription> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO tenant_subscriptions (
        tenant_id, plan_name, price_cents, currency, billing_frequency,
        status, payment_method_brand, payment_method_last4,
        trial_ends_at, next_billing_date, cancelled_at,
        show_billing_portal, admin_notes,
        stripe_price_id, stripe_product_id, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_name = COALESCE($2, tenant_subscriptions.plan_name),
        price_cents = COALESCE($3, tenant_subscriptions.price_cents),
        currency = COALESCE($4, tenant_subscriptions.currency),
        billing_frequency = COALESCE($5, tenant_subscriptions.billing_frequency),
        status = COALESCE($6, tenant_subscriptions.status),
        payment_method_brand = COALESCE($7, tenant_subscriptions.payment_method_brand),
        payment_method_last4 = COALESCE($8, tenant_subscriptions.payment_method_last4),
        trial_ends_at = COALESCE($9, tenant_subscriptions.trial_ends_at),
        next_billing_date = COALESCE($10, tenant_subscriptions.next_billing_date),
        cancelled_at = $11,
        show_billing_portal = COALESCE($12, tenant_subscriptions.show_billing_portal),
        admin_notes = COALESCE($13, tenant_subscriptions.admin_notes),
        stripe_price_id = COALESCE($14, tenant_subscriptions.stripe_price_id),
        stripe_product_id = COALESCE($15, tenant_subscriptions.stripe_product_id),
        updated_at = now()
      RETURNING *`,
      [
        tenantId,
        data.planName ?? "Starter",
        data.priceCents ?? 0,
        data.currency ?? "usd",
        data.billingFrequency ?? "monthly",
        data.status ?? "trial",
        data.paymentMethodBrand ?? null,
        data.paymentMethodLast4 ?? null,
        data.trialEndsAt ?? null,
        data.nextBillingDate ?? null,
        data.cancelledAt ?? null,
        data.showBillingPortal ?? true,
        data.adminNotes ?? null,
        data.stripePriceId ?? null,
        data.stripeProductId ?? null,
      ]
    );
    return rowToSubscription(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function pingPool(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
