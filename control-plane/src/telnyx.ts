/**
 * Telnyx API integration for phone number management.
 *
 * Environment variables:
 *   TELNYX_API_KEY        - Your Telnyx API v2 key (required)
 *   TELNYX_CONNECTION_ID  - The connection/app ID with your webhook URL configured
 *   VERALUX_WEBHOOK_URL   - The public webhook URL for voice calls (used when creating connections)
 */

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

function getApiKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error("TELNYX_API_KEY not configured");
  return key;
}

function getConnectionId(): string | undefined {
  return process.env.TELNYX_CONNECTION_ID;
}

function getWebhookUrl(): string | undefined {
  return process.env.VERALUX_WEBHOOK_URL;
}

async function telnyxFetch<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const apiKey = getApiKey();
  const url = endpoint.startsWith("http") ? endpoint : `${TELNYX_API_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `Telnyx API error: ${res.status}`;
    try {
      const err = JSON.parse(text);
      message = err.errors?.[0]?.detail || err.message || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

/* ────────────────────────────────────────────────
   Types
   ──────────────────────────────────────────────── */

export interface TelnyxPhoneNumber {
  id: string;
  record_type: string;
  phone_number: string;
  status: string;
  connection_id: string | null;
  connection_name: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  purchased_at: string;
  billing_group_id: string | null;
  emergency_enabled: boolean;
  messaging_profile_id: string | null;
  external_pin?: string;
}

export interface TelnyxAvailableNumber {
  record_type: string;
  phone_number: string;
  vanity_format: string | null;
  best_effort: boolean;
  quickship: boolean;
  reservable: boolean;
  region_information: Array<{
    region_type: string;
    region_name: string;
  }>;
  cost_information: {
    upfront_cost: string;
    monthly_cost: string;
    currency: string;
  };
  features: Array<{ name: string }>;
}

export interface TelnyxNumberOrder {
  id: string;
  record_type: string;
  status: string;
  customer_reference: string | null;
  created_at: string;
  updated_at: string;
  phone_numbers: Array<{
    id: string;
    phone_number: string;
    status: string;
    requirements_met: boolean;
  }>;
  phone_numbers_count: number;
}

export interface TelnyxConnection {
  id: string;
  record_type: string;
  active: boolean;
  connection_name: string;
  webhook_event_url: string;
  webhook_event_failover_url: string | null;
  webhook_api_version: string;
  webhook_timeout_secs: number;
  created_at: string;
  updated_at: string;
}

/* ────────────────────────────────────────────────
   API Functions
   ──────────────────────────────────────────────── */

/**
 * Check if Telnyx integration is configured.
 */
export function isTelnyxConfigured(): boolean {
  return Boolean(process.env.TELNYX_API_KEY);
}

/**
 * List all phone numbers in the Telnyx account.
 */
export async function listPhoneNumbers(): Promise<TelnyxPhoneNumber[]> {
  const numbers: TelnyxPhoneNumber[] = [];
  let pageNumber = 1;
  const pageSize = 250;

  while (true) {
    const res = await telnyxFetch<{
      data: TelnyxPhoneNumber[];
      meta: { page_number: number; page_size: number; total_pages: number; total_results: number };
    }>(`/phone_numbers?page[number]=${pageNumber}&page[size]=${pageSize}`);

    numbers.push(...res.data);

    if (pageNumber >= res.meta.total_pages) break;
    pageNumber++;
  }

  return numbers;
}

/**
 * Get a single phone number by ID.
 */
export async function getPhoneNumber(id: string): Promise<TelnyxPhoneNumber> {
  const res = await telnyxFetch<{ data: TelnyxPhoneNumber }>(`/phone_numbers/${id}`);
  return res.data;
}

/**
 * Search for available phone numbers to purchase.
 */
export async function searchAvailableNumbers(opts: {
  country_code: string;
  administrative_area?: string;
  locality?: string;
  contains?: string;
  starts_with?: string;
  ends_with?: string;
  limit?: number;
  features?: string[];
}): Promise<TelnyxAvailableNumber[]> {
  const params = new URLSearchParams();
  params.set("filter[country_code]", opts.country_code);
  if (opts.administrative_area) params.set("filter[administrative_area]", opts.administrative_area);
  if (opts.locality) params.set("filter[locality]", opts.locality);
  if (opts.contains) params.set("filter[phone_number][contains]", opts.contains);
  if (opts.starts_with) params.set("filter[phone_number][starts_with]", opts.starts_with);
  if (opts.ends_with) params.set("filter[phone_number][ends_with]", opts.ends_with);
  params.set("filter[limit]", String(opts.limit || 10));
  if (opts.features?.length) {
    opts.features.forEach((f) => params.append("filter[features][]", f));
  }

  const res = await telnyxFetch<{ data: TelnyxAvailableNumber[] }>(
    `/available_phone_numbers?${params.toString()}`
  );
  return res.data;
}

/**
 * Purchase phone numbers.
 */
export async function purchaseNumbers(
  phoneNumbers: string[],
  connectionId?: string
): Promise<TelnyxNumberOrder> {
  const connId = connectionId || getConnectionId();

  const res = await telnyxFetch<{ data: TelnyxNumberOrder }>("/number_orders", {
    method: "POST",
    body: JSON.stringify({
      phone_numbers: phoneNumbers.map((n) => ({
        phone_number: n,
        connection_id: connId,
      })),
    }),
  });

  return res.data;
}

/**
 * Update a phone number's connection (assigns webhook).
 */
export async function assignNumberToConnection(
  phoneNumberId: string,
  connectionId?: string
): Promise<TelnyxPhoneNumber> {
  const connId = connectionId || getConnectionId();
  if (!connId) throw new Error("No connection ID configured (TELNYX_CONNECTION_ID)");

  const res = await telnyxFetch<{ data: TelnyxPhoneNumber }>(`/phone_numbers/${phoneNumberId}`, {
    method: "PATCH",
    body: JSON.stringify({ connection_id: connId }),
  });

  return res.data;
}

/**
 * List Call Control Applications (connections).
 */
export async function listConnections(): Promise<TelnyxConnection[]> {
  const res = await telnyxFetch<{ data: TelnyxConnection[] }>("/call_control_applications");
  return res.data;
}

/**
 * Create a new Call Control Application with the webhook URL.
 */
export async function createConnection(name: string, webhookUrl?: string): Promise<TelnyxConnection> {
  const url = webhookUrl || getWebhookUrl();
  if (!url) throw new Error("No webhook URL configured (VERALUX_WEBHOOK_URL)");

  const res = await telnyxFetch<{ data: TelnyxConnection }>("/call_control_applications", {
    method: "POST",
    body: JSON.stringify({
      connection_name: name,
      webhook_event_url: url,
      webhook_api_version: "2",
      first_command_timeout: true,
      first_command_timeout_secs: 30,
    }),
  });

  return res.data;
}

/**
 * Ensure we have a connection configured. Creates one if needed.
 */
export async function ensureConnection(): Promise<string> {
  const existingId = getConnectionId();
  if (existingId) return existingId;

  // Try to find an existing connection with our webhook URL
  const webhookUrl = getWebhookUrl();
  if (webhookUrl) {
    const connections = await listConnections();
    const match = connections.find((c) => c.webhook_event_url === webhookUrl);
    if (match) {
      console.log(`[telnyx] Found existing connection: ${match.id}`);
      return match.id;
    }
  }

  // Create a new connection
  const newConn = await createConnection("VeraLux Voice", webhookUrl);
  console.log(`[telnyx] Created new connection: ${newConn.id}`);
  console.log(`[telnyx] ⚠️  Set TELNYX_CONNECTION_ID=${newConn.id} to reuse this connection.`);
  return newConn.id;
}

/**
 * Provision an existing number: assign it to the VeraLux connection.
 * Returns the updated phone number.
 */
export async function provisionExistingNumber(
  phoneNumber: string
): Promise<TelnyxPhoneNumber> {
  // Find the phone number in the account
  const numbers = await listPhoneNumbers();
  const match = numbers.find(
    (n) => n.phone_number === phoneNumber || n.phone_number === `+${phoneNumber.replace(/^\+/, "")}`
  );

  if (!match) {
    throw new Error(`Phone number ${phoneNumber} not found in your Telnyx account`);
  }

  const connectionId = await ensureConnection();
  return assignNumberToConnection(match.id, connectionId);
}

/**
 * Purchase and provision a new number.
 */
export async function purchaseAndProvisionNumber(
  phoneNumber: string
): Promise<{ order: TelnyxNumberOrder; phoneNumber: TelnyxPhoneNumber | null }> {
  const connectionId = await ensureConnection();

  const order = await purchaseNumbers([phoneNumber], connectionId);

  // The number may take a moment to be ready; return order status
  // Caller can poll or handle async provisioning
  let phoneNumberData: TelnyxPhoneNumber | null = null;

  if (order.phone_numbers?.[0]?.id) {
    try {
      phoneNumberData = await getPhoneNumber(order.phone_numbers[0].id);
    } catch {
      // Number may not be ready yet
    }
  }

  return { order, phoneNumber: phoneNumberData };
}

/**
 * Get a summary of Telnyx configuration status.
 */
export function getConfigStatus(): {
  configured: boolean;
  hasApiKey: boolean;
  hasConnectionId: boolean;
  hasWebhookUrl: boolean;
  connectionId?: string;
  webhookUrl?: string;
} {
  return {
    configured: isTelnyxConfigured(),
    hasApiKey: Boolean(process.env.TELNYX_API_KEY),
    hasConnectionId: Boolean(process.env.TELNYX_CONNECTION_ID),
    hasWebhookUrl: Boolean(process.env.VERALUX_WEBHOOK_URL),
    connectionId: getConnectionId(),
    webhookUrl: getWebhookUrl(),
  };
}
