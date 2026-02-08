/** Per-tenant context: pricing, products, hours, policies, etc. Keys are section names; values are text. */
export type AssistantContext = Record<string, string>;

export function defaultBrainReply(args: {
  transcript: string;
  tenantId?: string;
  assistantContext?: AssistantContext;
}): string {
  void args.tenantId;
  const text = args.transcript.trim().toLowerCase();
  const ctx = args.assistantContext;

  // If we have context, use it for pricing / products / hours / other sections
  if (ctx && Object.keys(ctx).length > 0) {
    const pricing = ctx.pricing?.trim();
    const products = ctx.products?.trim();
    const hours = ctx.hours?.trim();
    const other = ctx.other?.trim();
    const anySection = pricing || products || hours || other;

    if (anySection) {
      if (
        text.includes('price') ||
        text.includes('cost') ||
        text.includes('how much') ||
        text.includes('pricing')
      ) {
        if (pricing) return pricing;
        if (products) return `Here’s our product info: ${products}`;
      }
      if (
        text.includes('product') ||
        text.includes('service') ||
        text.includes('offer') ||
        text.includes('what do you')
      ) {
        if (products) return products;
        if (pricing) return `Here’s our pricing: ${pricing}`;
      }
      if (
        text.includes('open') ||
        text.includes('close') ||
        text.includes('hour') ||
        text.includes('when are you')
      ) {
        if (hours) return hours;
      }
      // Generic "info" or "tell me" — return first available section
      if (
        text.includes('info') ||
        text.includes('tell me') ||
        text.includes('explain') ||
        text.length < 20
      ) {
        if (pricing) return pricing;
        if (products) return products;
        if (hours) return hours;
        if (other) return other;
      }
      // Check other custom keys (e.g. policies, faq)
      for (const [section, value] of Object.entries(ctx)) {
        if (value?.trim() && text.includes(section.toLowerCase())) {
          return value.trim();
        }
      }
    }
  }

  // Fallback when no context or no match
  if (text.includes('open')) {
    return 'We open at 9 AM.';
  }

  if (text.includes('close') || text.includes('closing')) {
    return 'We close at 6 PM.';
  }

  if (text.includes('hours')) {
    return 'Our hours are 9 AM to 6 PM, Monday through Saturday.';
  }

  if (text.includes('appointment') || text.includes('book')) {
    return 'Sure - would you like to book for today or another day?';
  }

  return 'Got it - do you want hours, services, or to book an appointment?';
}
