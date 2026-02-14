import { LLMConfigStore, type SerializedLLMConfig } from "./config";
import { InMemoryCallStore } from "./state";
import { AnalyticsTracker } from "./analytics";
import {
  fetchTenantsFromDb,
  runMigrations,
  setTenantNumbers,
  upsertAnalyticsRow,
  upsertCalls,
  upsertConfig,
  upsertTenant,
  type AnalyticsRow,
  type CallRow,
  type ConfigRow,
  type BrandingConfig,
} from "./db";
import { secretStore } from "./secretStore";
import { normalizePhoneNumber } from "./utils/phone";
import {
  parseForwardingProfiles,
  parsePricingInfo,
  DEFAULT_PRICING,
  type ForwardingProfile,
  type PricingInfo,
} from "./llmContext";


export interface TenantMeta {
  id: string;
  name: string;
  /** Telnyx numbers that receive calls (for routing) */
  numbers: string[];
  /** Customer's original business number (for display, forwarding instructions) */
  businessNumber?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TenantContext {
  id: string;
  meta: TenantMeta;
  config: LLMConfigStore;
  calls: InMemoryCallStore;
  analytics: AnalyticsTracker;
  /** Call forwarding profiles (who to transfer to) – used by LLM */
  forwardingProfiles: ForwardingProfile[];
  /** Pricing information – used by LLM */
  pricing: PricingInfo;
  /** Branding: logo, colors, display name for documents/emails */
  branding: BrandingConfig;
}


const DEFAULT_TENANT_ID =
  (process.env.DEFAULT_TENANT_ID && process.env.DEFAULT_TENANT_ID.trim()) ||
  "default";

function toConfigRow(tenantId: string, ctx: TenantContext): ConfigRow {
  const serialized = ctx.config.serialize();
  return {
    tenant_id: tenantId,
    config: {
      ...serialized.config,
      openaiApiKey: undefined,
    } as SerializedLLMConfig["config"],
    prompts: serialized.prompts,
    stt: serialized.stt,
    tts: serialized.tts,
    forwarding_profiles: ctx.forwardingProfiles,
    pricing: ctx.pricing,
    branding: ctx.branding,
  };
}

function toAnalyticsRow(tenantId: string, tracker: AnalyticsTracker): AnalyticsRow {
  const serialized = tracker.serialize();
  return {
    tenant_id: tenantId,
    call_count: serialized.callCount,
    caller_message_count: serialized.callerMessageCount,
    question_counts: Object.fromEntries(serialized.questionCounts) as Record<
      string,
      number
    >,
  };
}

function toCallRows(tenantId: string, calls: InMemoryCallStore): CallRow[] {
  return calls.serialize().map((call) => ({
    id: call.id,
    tenant_id: tenantId,
    caller_id: call.callerId || null,
    stage: call.stage,
    lead: call.lead,
    history: call.history,
  }));
}

export class TenantRegistry {
  private tenants = new Map<string, TenantContext>();
  private numberToTenant = new Map<string, string>();
  private initialized = false;

  private async ensureTenantRow(ctx: TenantContext): Promise<void> {
    await upsertTenant({
      id: ctx.id,
      name: ctx.meta.name,
      createdAt: ctx.meta.createdAt,
      updatedAt: ctx.meta.updatedAt,
    });
    await setTenantNumbers(ctx.id, ctx.meta.numbers || []);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await runMigrations();
    const data = await fetchTenantsFromDb();

    for (const tenantRow of data.tenants) {
      const meta: TenantMeta = {
        id: tenantRow.id,
        name: tenantRow.name,
        numbers: [],
        createdAt: Date.parse(tenantRow.created_at) || Date.now(),
        updatedAt: Date.parse(tenantRow.updated_at) || Date.now(),
      };

      const numbers = data.numbers
        .filter((n) => n.tenant_id === tenantRow.id)
        .map((n) => normalizePhoneNumber(n.number))
        .filter(Boolean);

      meta.numbers = numbers;
      numbers.forEach((n) => this.numberToTenant.set(n, tenantRow.id));

      const configRow = data.configs.find((c) => c.tenant_id === tenantRow.id);
      const config = new LLMConfigStore(
        configRow
          ? {
              config: configRow.config as SerializedLLMConfig["config"],
              prompts: configRow.prompts as SerializedLLMConfig["prompts"],
              stt: configRow.stt as SerializedLLMConfig["stt"],
              tts: configRow.tts as SerializedLLMConfig["tts"],
            }
          : undefined
      );
      const forwardingProfiles = configRow
        ? parseForwardingProfiles(configRow.forwarding_profiles)
        : [];
      const pricing = configRow ? parsePricingInfo(configRow.pricing) : { ...DEFAULT_PRICING };
      const branding: BrandingConfig = (configRow?.branding && typeof configRow.branding === "object")
        ? configRow.branding as BrandingConfig
        : {};

      // hydrate OpenAI key from secret store
      const secretKey = await secretStore.getSecret(tenantRow.id, "openai_api_key");
      if (secretKey) {
        config.set({ openaiApiKey: secretKey });
      }

      const calls = data.calls
        .filter((c) => c.tenant_id === tenantRow.id)
        .map((c) => ({
          id: c.id,
          tenantId: c.tenant_id,
          callerId: c.caller_id || undefined,
          stage: (c.stage as any) || "greeting",
          lead: c.lead || {},
          history: Array.isArray(c.history) ? c.history : [],
        }));

      // ✅ IMPORTANT: declare ctx before callbacks capture it
      let ctx!: TenantContext;

      const analyticsRow = data.analytics.find((a) => a.tenant_id === tenantRow.id);
      const analytics = new AnalyticsTracker(
        analyticsRow
          ? {
              callCount: analyticsRow.call_count,
              callerMessageCount: analyticsRow.caller_message_count,
              questionCounts: Object.entries(analyticsRow.question_counts || {}),
            }
          : undefined,
        () => {
          void this.ensureTenantRow(ctx).then(() =>
            upsertAnalyticsRow(toAnalyticsRow(meta.id, analytics))
          );
        }
      );

      const callsStore = new InMemoryCallStore(
        tenantRow.id,
        calls,
        () => {
          void this.ensureTenantRow(ctx).then(() =>
            upsertCalls(tenantRow.id, toCallRows(tenantRow.id, callsStore))
          );
        }
      );

      ctx = {
        id: tenantRow.id,
        meta,
        config,
        calls: callsStore,
        analytics,
        forwardingProfiles,
        pricing,
        branding,
      };



      this.tenants.set(tenantRow.id, ctx);
    }

    // Ensure default tenant exists
    if (!this.tenants.has(DEFAULT_TENANT_ID)) {
      await this.createAndPersist(DEFAULT_TENANT_ID, "Default Tenant");
    }

    this.initialized = true;
  }

  listMetas(): TenantMeta[] {
    this.ensureInitialized();
    return Array.from(this.tenants.values()).map((t) => t.meta);
  }

  getOrCreate(id?: string, name?: string): TenantContext {
    this.ensureInitialized();
    const tenantId = (id || DEFAULT_TENANT_ID).trim();
    const existing = this.tenants.get(tenantId);
    if (existing) return existing;
    return this.createAndPersist(tenantId, name || tenantId);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("Tenant registry not initialized. Call init() before use.");
    }
  }

  private createAndPersist(id: string, name: string): TenantContext {
    const createdAt = Date.now();
    const meta: TenantMeta = {
      id,
      name,
      numbers: [],
      createdAt,
      updatedAt: createdAt,
    };

    const config = new LLMConfigStore();

    let ctx!: TenantContext;

    const analytics = new AnalyticsTracker(undefined, () => {
      void this.ensureTenantRow(ctx).then(() =>
        upsertAnalyticsRow(toAnalyticsRow(id, analytics))
      );
    });

    const calls = new InMemoryCallStore(id, undefined, () => {
      void this.ensureTenantRow(ctx).then(() =>
        upsertCalls(id, toCallRows(id, calls))
      );
    });

    ctx = {
      id,
      meta,
      config,
      calls,
      analytics,
      forwardingProfiles: [],
      pricing: { ...DEFAULT_PRICING },
      branding: {},
    };

    this.tenants.set(id, ctx);

    void this.ensureTenantRow(ctx).then(() => {
      void upsertConfig(toConfigRow(id, ctx));
      void upsertAnalyticsRow(toAnalyticsRow(id, analytics));
    });

    return ctx;
  }

  getByNumber(number: string): TenantContext | undefined {
    this.ensureInitialized();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return undefined;
    const tenantId = this.numberToTenant.get(normalized);
    if (!tenantId) return undefined;
    return this.tenants.get(tenantId);
  }

  findTenantForCall(callId: string): TenantContext | undefined {
    this.ensureInitialized();
    for (const ctx of this.tenants.values()) {
      if (ctx.calls.getCall(callId)) return ctx;
    }
    return undefined;
  }

  upsertMeta(
    tenantId: string,
    meta: Partial<Pick<TenantMeta, "name" | "numbers" | "businessNumber">>
  ): TenantContext {
    this.ensureInitialized();
    const ctx = this.getOrCreate(tenantId);

    const nextMeta: TenantMeta = {
      ...ctx.meta,
      ...("name" in meta && meta.name
        ? { name: meta.name.trim() || tenantId }
        : {}),
    };

    // Update businessNumber if provided
    if ("businessNumber" in meta) {
      nextMeta.businessNumber = meta.businessNumber?.trim() || undefined;
    }

    if (meta.numbers && Array.isArray(meta.numbers)) {
      ctx.meta.numbers.forEach((n) => {
        const normalized = normalizePhoneNumber(n);
        const owner = this.numberToTenant.get(normalized);
        if (owner === tenantId) this.numberToTenant.delete(normalized);
      });

      const filtered = meta.numbers
        .map((n) => normalizePhoneNumber(n))
        .filter(Boolean);

      nextMeta.numbers = Array.from(new Set(filtered));
      nextMeta.numbers.forEach((n) => this.numberToTenant.set(n, tenantId));

      void setTenantNumbers(tenantId, nextMeta.numbers);
    } else {
      nextMeta.numbers = ctx.meta.numbers;
    }

    nextMeta.updatedAt = Date.now();

    const updatedContext: TenantContext = {
      ...ctx,
      meta: nextMeta,
    };

    this.tenants.set(tenantId, updatedContext);
    void this.ensureTenantRow(updatedContext);

    return updatedContext;
  }

  persistConfig(tenantId: string): void {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return;
    void this.ensureTenantRow(ctx).then(() =>
      upsertConfig(toConfigRow(tenantId, ctx))
    );
  }

  setForwardingProfiles(tenantId: string, profiles: ForwardingProfile[]): TenantContext | undefined {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return undefined;
    ctx.forwardingProfiles = profiles;
    this.persistConfig(tenantId);
    return ctx;
  }

  setPricing(tenantId: string, pricing: PricingInfo): TenantContext | undefined {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return undefined;
    ctx.pricing = pricing;
    this.persistConfig(tenantId);
    return ctx;
  }

  setBranding(tenantId: string, branding: BrandingConfig): TenantContext | undefined {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return undefined;
    ctx.branding = { ...ctx.branding, ...branding };
    this.persistConfig(tenantId);
    return ctx;
  }

  getBranding(tenantId: string): BrandingConfig {
    const ctx = this.tenants.get(tenantId);
    return ctx?.branding ?? {};
  }

  persistCalls(tenantId: string): void {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return;
    void this.ensureTenantRow(ctx).then(() =>
      upsertCalls(tenantId, toCallRows(tenantId, ctx.calls))
    );
  }

  persistAnalytics(tenantId: string): void {
    const ctx = this.tenants.get(tenantId);
    if (!ctx) return;
    void this.ensureTenantRow(ctx).then(() =>
      upsertAnalyticsRow(toAnalyticsRow(tenantId, ctx.analytics))
    );
  }
}

export const tenants = new TenantRegistry();
export { DEFAULT_TENANT_ID };
