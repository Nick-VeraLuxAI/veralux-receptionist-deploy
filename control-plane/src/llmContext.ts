/**
 * Types and defaults for LLM-visible context: call forwarding profiles and pricing.
 * Edited in the dashboard and included in prompt/context so the receptionist can
 * reference who to transfer to and what things cost.
 */

export interface ForwardingProfile {
  id: string;
  name: string;
  number: string;
  role: string;
}

export interface PricingItem {
  id: string;
  name: string;
  price: string;
  description?: string;
}

export interface PricingInfo {
  items: PricingItem[];
  notes?: string;
}

export const DEFAULT_PRICING: PricingInfo = {
  items: [],
  notes: "",
};

function generateId(): string {
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createForwardingProfile(
  profile: Partial<ForwardingProfile> & Pick<ForwardingProfile, "name">
): ForwardingProfile {
  return {
    id: profile.id ?? generateId(),
    name: profile.name,
    number: profile.number ?? "",
    role: profile.role ?? "",
  };
}

export function createPricingItem(
  item: Partial<PricingItem> & Pick<PricingItem, "name">
): PricingItem {
  return {
    id: item.id ?? generateId(),
    name: item.name,
    price: item.price ?? "",
    description: item.description,
  };
}

export function parseForwardingProfiles(raw: unknown): ForwardingProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p): p is Record<string, unknown> =>
        p != null && typeof p === "object" && typeof (p as any).name === "string"
    )
    .map((p) => ({
      id: typeof (p as any).id === "string" ? (p as any).id : generateId(),
      name: String((p as any).name),
      number: typeof (p as any).number === "string" ? (p as any).number : "",
      role: typeof (p as any).role === "string" ? (p as any).role : "",
    }));
}

export function parsePricingInfo(raw: unknown): PricingInfo {
  if (raw == null || typeof raw !== "object") return { ...DEFAULT_PRICING };
  const o = raw as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? (o.items as unknown[]).filter(
        (p): p is Record<string, unknown> =>
          p != null && typeof p === "object" && typeof (p as any).name === "string"
      ).map((p) => ({
        id: typeof (p as any).id === "string" ? (p as any).id : generateId(),
        name: String((p as any).name),
        price: typeof (p as any).price === "string" ? (p as any).price : String((p as any).price ?? ""),
        description: typeof (p as any).description === "string" ? (p as any).description : undefined,
      }))
    : [];
  const notes = typeof o.notes === "string" ? o.notes : "";
  return { items, notes };
}
