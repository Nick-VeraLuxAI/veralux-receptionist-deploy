import type { LLMProvider, LLMConfigStore } from "./config";
import { tenants, DEFAULT_TENANT_ID } from "./tenants";

export interface LocalLLMInput {
  prompt: string;
}

export interface LocalLLMOutput {
  rawText: string;
}

const DEFAULT_LLM_URL = "http://127.0.0.1:8080/completion";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "llama3.2:3b";

function getConfigStore(
  opts?: Partial<{ tenantId?: string; config?: LLMConfigStore }>
): LLMConfigStore {
  if (opts?.config) return opts.config;
  const tenantId = opts?.tenantId || DEFAULT_TENANT_ID;
  return tenants.getOrCreate(tenantId).config;
}

export async function callLocalLLM(
  input: LocalLLMInput,
  opts?: { config?: LLMConfigStore; tenantId?: string }
): Promise<LocalLLMOutput> {
  const cfgStore = getConfigStore(opts);
  const cfg = cfgStore.get();
  const url = cfg.localUrl || process.env.LOCAL_LLM_URL || DEFAULT_LLM_URL;

  const body = {
    prompt: input.prompt,
    n_predict: 400,
    stream: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Local LLM error: ${res.status} ${res.statusText} - ${text}`
    );
  }

  const text = await res.text();

  try {
    const json = JSON.parse(text);
    if (typeof json.content === "string") {
      return { rawText: json.content };
    }
    if (typeof json.response === "string") {
      return { rawText: json.response };
    }
    if (
      Array.isArray(json.choices) &&
      json.choices[0] &&
      typeof json.choices[0].text === "string"
    ) {
      return { rawText: json.choices[0].text };
    }
  } catch {
    // ignore, we'll fall back to plain text
  }

  return { rawText: text };
}

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export async function callOpenAILLM(
  input: LocalLLMInput,
  opts?: Partial<OpenAIConfig> & { config?: LLMConfigStore; tenantId?: string }
): Promise<LocalLLMOutput> {
  const cfgStore = getConfigStore(opts);
  const runtimeCfg = cfgStore.get();
  const apiKey =
    opts?.apiKey || runtimeCfg.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }

  const baseUrl = (
    opts?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_URL
  ).replace(/\/$/, "");
  const model =
    opts?.model ||
    runtimeCfg.openaiModel ||
    process.env.OPENAI_MODEL ||
    DEFAULT_OPENAI_MODEL;

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: input.prompt }],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json().catch(() => undefined);
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    return { rawText: content };
  }
  const text = choice?.text;
  if (typeof text === "string") {
    return { rawText: text };
  }

  return { rawText: JSON.stringify(data ?? {}) };
}

export async function callLLM(
  input: LocalLLMInput,
  opts?: { tenantId?: string; config?: LLMConfigStore }
): Promise<LocalLLMOutput> {
  const cfgStore = getConfigStore(opts);
  const configProvider: LLMProvider | string = cfgStore.get().provider;
  const envProvider = (process.env.LLM_PROVIDER || "").toLowerCase();
  const provider = (configProvider || envProvider) as LLMProvider | string;
  if (provider === "openai" || provider === "cloud") {
    return callOpenAILLM(input, { ...opts, config: cfgStore });
  }
  return callLocalLLM(input, { ...opts, config: cfgStore });
}
