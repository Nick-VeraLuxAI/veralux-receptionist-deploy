import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

type NormalizationInfo = {
  trim?: boolean;
  e164?: boolean;
  whitespace?: boolean;
  lines: string[];
};

type ShapeInfo = {
  topLevel: Set<string>;
  nested: Record<string, Set<string>>;
};

type ReportInfo = {
  path: string;
  exists: boolean;
  content: string;
  didKeyFormat?: string;
  didPrefix?: string;
  tenantCfgKeyFormat?: string;
  tenantCfgPrefix?: string;
  schemaVersion?: string;
  normalization: NormalizationInfo;
  shape?: ShapeInfo;
  requiredFields?: Set<string>;
  altRequiredGroups: string[];
};

type DidMappingParts = {
  base?: string;
  suffix?: string;
};

type TenantCfgParts = {
  base?: string;
  delimiter?: string;
  suffix?: string;
};

const CONTROL_REPORT_PATH = path.join(
  process.cwd(),
  "docs",
  "runtime_integration_report.md"
);
const RUNTIME_REPORT_PATH = path.join(
  process.cwd(),
  "docs",
  "redis_contract_report.md"
);

const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]+\}\}/g,
  /\$\{[^}]+\}/g,
  /\{[^}]+\}/g,
  /<[^>]+>/g,
  /\[[^\]]+\]/g,
];

function readFileSafe(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function extractBackticks(line: string): string[] {
  const matches = [...line.matchAll(/`([^`]+)`/g)];
  return matches.map((m) => m[1]);
}

function extractFirstMatch(content: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return undefined;
}

function stripPlaceholder(format: string): string {
  let prefix = format;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    prefix = prefix.replace(pattern, "");
  }
  return prefix;
}

function hasPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => Boolean(value.match(pattern)));
}

function extractEnvVarValue(content: string, varName: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(varName)) continue;
    const ticks = extractBackticks(line);
    if (ticks.length) {
      const value = ticks.find((tick) => tick !== varName);
      if (value) return value;
    }
    const match = line.match(new RegExp(`${varName}\\s*[:=]\\s*([^\\s,]+)`));
    if (match && match[1]) return match[1].replace(/[`,]/g, "");
  }
  return undefined;
}

function extractSection(lines: string[], heading: RegExp): string[] {
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (line.startsWith("#")) break;
    if (!line.startsWith("-") && /^[A-Z][A-Za-z0-9 /-]+:$/.test(line.trim())) {
      break;
    }
    section.push(line);
  }
  return section;
}

function extractJsonExample(content: string): unknown | undefined {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  if (!match || !match[1]) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function extractShape(json: unknown): ShapeInfo | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;
  const topLevel = new Set(Object.keys(obj));
  const nested: Record<string, Set<string>> = {};
  ["caps", "stt", "tts", "audio"].forEach((key) => {
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      nested[key] = new Set(Object.keys(value as Record<string, unknown>));
    }
  });
  return { topLevel, nested };
}

function extractRequiredFields(lines: string[]): Set<string> | undefined {
  const required = new Set<string>();
  for (const line of lines) {
    if (!/required fields?/i.test(line)) continue;
    const ticks = extractBackticks(line);
    if (ticks.length) {
      ticks.forEach((t) => required.add(t));
      continue;
    }
    const fallback = line
      .replace(/.*required fields?\s*[:\-]?\s*/i, "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    fallback.forEach((t) => required.add(t));
  }
  return required.size ? required : undefined;
}

function extractAltRequiredGroups(lines: string[]): string[] {
  const groups = new Set<string>();
  for (const line of lines) {
    const match = line.match(/`([^`]+)`\s+or\s+`([^`]+)`.*required/i);
    if (match) {
      const group = [match[1], match[2]].sort().join("|");
      groups.add(group);
    }
  }
  return [...groups];
}

function extractNormalization(lines: string[]): NormalizationInfo {
  const normalizationLines = extractSection(lines, /^Normalization:/i);
  const didLines = normalizationLines.length
    ? normalizationLines
    : lines.filter((line) => /did/i.test(line));
  if (!didLines.length) {
    return { lines: [] };
  }
  const combined = didLines.join(" ").toLowerCase();
  const trim = /\btrim/.test(combined);
  const e164 = /e\.?164/.test(combined) || /\\\+\[1-9]/.test(combined);
  const whitespace = /whitespace|spaces?/.test(combined);
  return { trim, e164, whitespace, lines: didLines };
}

function buildNormalizationInfoFromValue(value: string): NormalizationInfo {
  const combined = value.toLowerCase();
  return {
    trim: /\btrim/.test(combined),
    e164: /e\.?164/.test(combined) || /\\\+\[1-9]/.test(combined),
    whitespace: /whitespace|spaces?|\\s\+/.test(combined),
    lines: [`Normalization: \`${value}\``],
  };
}

function extractRuntimeKeyFormat(
  content: string,
  section: RegExp,
  fallback: RegExp
): string | undefined {
  return extractFirstMatch(content, [
    new RegExp(`${section.source}[\\s\\S]*?Key format:\\s*` + "`?([^\\n`]+)`?", "i"),
    fallback,
  ]);
}

function extractRuntimeDefaultPrefix(
  content: string,
  varName: string,
  fallback: string
): string {
  const value =
    extractFirstMatch(content, [
      new RegExp(`${varName}[^\\n]*default\\s*` + "`([^`]+)`", "i"),
      new RegExp(`${varName}[^\\n]*default\\s*([A-Za-z0-9:_-]+)`, "i"),
    ]) || extractEnvVarValue(content, varName);
  return value || fallback;
}

function extractSchemaVersionFromText(content: string): string | undefined {
  const match = content.match(/contractVersion[^"\n]*"v(\d+)"/i);
  if (match?.[1]) return `v${match[1]}`;
  const schema = content.match(/Schema version:\s*`?v(\d+)`?/i);
  if (schema?.[1]) return `v${schema[1]}`;
  return undefined;
}

function parseDidMappingParts(
  didKeyFormat?: string,
  didPrefix?: string,
  defaultSuffix?: string
): DidMappingParts {
  let base: string | undefined;
  let suffix: string | undefined;

  if (didKeyFormat) {
    const didIndex = didKeyFormat.indexOf(":did:");
    if (didIndex >= 0) {
      base = didKeyFormat.slice(0, didIndex);
      suffix = ":did:";
    } else {
      const stripped = stripPlaceholder(didKeyFormat);
      if (stripped) {
        base = stripped;
      }
    }
  }

  if (base && hasPlaceholder(base)) {
    base = undefined;
  }

  if (!base && didPrefix) {
    if (didPrefix.endsWith(":did:")) {
      base = didPrefix.slice(0, -":did:".length);
      suffix = suffix ?? ":did:";
    } else {
      base = didPrefix;
    }
  }

  if (base && !suffix && didKeyFormat) {
    const withoutBase = didKeyFormat.startsWith(base)
      ? didKeyFormat.slice(base.length)
      : didKeyFormat;
    const derived = stripPlaceholder(withoutBase);
    if (derived) suffix = derived;
  }

  if (base && !suffix && defaultSuffix) {
    suffix = defaultSuffix;
  }

  return {
    base: base?.trim() || undefined,
    suffix: suffix?.trim() || undefined,
  };
}

function parseTenantCfgParts(
  keyFormat?: string,
  prefix?: string
): TenantCfgParts {
  let base: string | undefined;
  let delimiter: string | undefined;
  let suffix: string | undefined;

  if (prefix) {
    if (prefix.endsWith(":")) {
      base = prefix.slice(0, -1);
      delimiter = ":";
    } else {
      base = prefix;
    }
  }

  if (keyFormat) {
    const colonIndex = keyFormat.indexOf(":");
    if (colonIndex >= 0) {
      delimiter = ":";
      suffix = keyFormat.slice(colonIndex + 1).trim();
    }

    if (!base) {
      const candidate = keyFormat.split(":")[0]?.trim();
      if (candidate && !hasPlaceholder(candidate)) {
        base = candidate;
      }
    }
  }

  if (base && hasPlaceholder(base)) {
    base = undefined;
  }

  return {
    base: base?.trim() || undefined,
    delimiter,
    suffix,
  };
}

function parseReport(filePath: string, mode: "control" | "runtime"): ReportInfo {
  const content = readFileSafe(filePath);
  const exists = content !== null;
  const safeContent = content ?? "";
  const lines = safeContent.split(/\r?\n/);
  const isRuntime = mode === "runtime";

  const runtimeDidKeyFormat = isRuntime
    ? extractRuntimeKeyFormat(
        safeContent,
        /Tenant DID -> tenantId mapping/i,
        /Key format:\s*`(\$\{TENANTMAP_PREFIX\}:did:\$\{normalized\})`/i
      )
    : undefined;

  const didKeyFormat =
    runtimeDidKeyFormat ||
    extractFirstMatch(safeContent, [
      /DID mapping key format:\s*`([^`]+)`/i,
      /DID map.*key.*format:\s*`([^`]+)`/i,
      /DID.*key.*format:\s*`([^`]+)`/i,
    ]);

  const runtimeTenantCfgKeyFormat = isRuntime
    ? extractRuntimeKeyFormat(
        safeContent,
        /Tenant runtime config/i,
        /Key format:\s*`(\$\{TENANTCFG_PREFIX\}:\$\{tenantId\})`/i
      )
    : undefined;

  const tenantCfgKeyFormat =
    runtimeTenantCfgKeyFormat ||
    extractFirstMatch(safeContent, [
      /Tenant config key format:\s*`([^`]+)`/i,
      /tenant cfg key format:\s*`([^`]+)`/i,
      /tenant config key.*`([^`]+)`/i,
    ]);

  const prefixes: string[] = [];
  lines.forEach((line) => {
    if (/prefixes:/i.test(line)) {
      prefixes.push(...extractBackticks(line));
    }
  });

  const runtimeDidPrefix = isRuntime
    ? extractRuntimeDefaultPrefix(safeContent, "TENANTMAP_PREFIX", "tenantmap")
    : undefined;

  const didPrefix =
    runtimeDidPrefix ||
    extractEnvVarValue(safeContent, "TENANTMAP_PREFIX") ||
    extractEnvVarValue(safeContent, "TENANT_MAP_PREFIX") ||
    extractEnvVarValue(safeContent, "TENANTMAP_KEY_PREFIX") ||
    prefixes.find((p) => /tenantmap|did/i.test(p)) ||
    (didKeyFormat ? stripPlaceholder(didKeyFormat) : undefined);

  const runtimeTenantCfgPrefix = isRuntime
    ? extractRuntimeDefaultPrefix(safeContent, "TENANTCFG_PREFIX", "tenantcfg")
    : undefined;

  const tenantCfgPrefix =
    runtimeTenantCfgPrefix ||
    extractEnvVarValue(safeContent, "TENANTCFG_PREFIX") ||
    extractEnvVarValue(safeContent, "TENANT_CONFIG_PREFIX") ||
    extractEnvVarValue(safeContent, "TENANTCFG_KEY_PREFIX") ||
    prefixes.find((p) => /tenantcfg|config/i.test(p)) ||
    (tenantCfgKeyFormat ? stripPlaceholder(tenantCfgKeyFormat) : undefined);

  const jsonExample = extractJsonExample(safeContent);
  const shape = extractShape(jsonExample);

  const schemaVersion =
    (jsonExample &&
      typeof jsonExample === "object" &&
      !Array.isArray(jsonExample) &&
      typeof (jsonExample as Record<string, unknown>).contractVersion === "string"
      ? String((jsonExample as Record<string, unknown>).contractVersion)
      : undefined) ||
    extractFirstMatch(safeContent, [/contractVersion.*`([^`]+)`/i]) ||
    extractFirstMatch(safeContent, [/schema version.*`([^`]+)`/i]) ||
    extractSchemaVersionFromText(safeContent);

  const requiredFields = extractRequiredFields(lines) || shape?.topLevel;
  const altRequiredGroups = extractAltRequiredGroups(lines);

  if (!altRequiredGroups.length && jsonExample && shape?.topLevel) {
    const hasWebhookSecret = shape.topLevel.has("webhookSecret");
    const hasWebhookSecretRef = shape.topLevel.has("webhookSecretRef");
    if (hasWebhookSecret || hasWebhookSecretRef) {
      altRequiredGroups.push(["webhookSecret", "webhookSecretRef"].sort().join("|"));
    }
  }

  const normalizationOverride = isRuntime
    ? extractFirstMatch(safeContent, [/Normalization:\s*`([^`]+)`/i])
    : undefined;

  return {
    path: filePath,
    exists,
    content: safeContent,
    didKeyFormat,
    didPrefix,
    tenantCfgKeyFormat,
    tenantCfgPrefix,
    schemaVersion,
    normalization: normalizationOverride
      ? buildNormalizationInfoFromValue(normalizationOverride)
      : extractNormalization(lines),
    shape,
    requiredFields,
    altRequiredGroups,
  };
}

function formatSet(values?: Set<string>): string {
  if (!values || values.size === 0) return "(none)";
  return [...values].sort().join(", ");
}

function formatNormalization(info: NormalizationInfo): string {
  const parts: string[] = [];
  if (info.trim) parts.push("trim");
  if (info.e164) parts.push("E.164");
  if (info.whitespace) parts.push("whitespace");
  return parts.length ? parts.join(", ") : "unknown";
}

function normalizationTokens(info: NormalizationInfo): Set<string> {
  const tokens = new Set<string>();
  const raw = info.lines.join(" ");
  const tickValues = extractBackticks(raw);
  const source = tickValues.length ? tickValues.join(",") : raw;
  source
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .forEach((token) => tokens.add(token));

  if (info.e164) tokens.add("e164");
  if (info.trim) tokens.add("trim");
  if (info.whitespace) tokens.add("whitespace");

  return tokens;
}

function hasE164Token(tokens: Set<string>): boolean {
  return (
    tokens.has("e.164") ||
    tokens.has("e164") ||
    [...tokens].some((token) => token.includes("e.164") || token.includes("e164"))
  );
}

function main() {
  const control = parseReport(CONTROL_REPORT_PATH, "control");
  const runtime = parseReport(RUNTIME_REPORT_PATH, "runtime");

  const mismatches: string[] = [];
  const fixes: string[] = [];

  if (!control.exists) {
    mismatches.push(
      `Missing control-plane report at ${CONTROL_REPORT_PATH}.`
    );
    fixes.push("Run `npm run report:runtime` in this repo to generate it.");
  }

  if (!runtime.exists) {
    mismatches.push(
      `Missing runtime report at ${RUNTIME_REPORT_PATH}.`
    );
    fixes.push("Generate the runtime repo report and copy it to docs/redis_contract_report.md.");
  }

  if (control.exists && runtime.exists) {
    const controlDid = parseDidMappingParts(
      control.didKeyFormat,
      control.didPrefix
    );
    const runtimeDid = parseDidMappingParts(
      runtime.didKeyFormat,
      runtime.didPrefix,
      ":did:"
    );

    if (!controlDid.base || !runtimeDid.base) {
      mismatches.push(
        `Unable to determine TENANTMAP_PREFIX base (control: ${controlDid.base ?? "unknown"}, runtime: ${runtimeDid.base ?? "unknown"}).`
      );
      fixes.push("Ensure both reports document TENANTMAP_PREFIX or DID key format.");
    } else if (controlDid.base !== runtimeDid.base) {
      mismatches.push(
        `TENANTMAP_PREFIX mismatch (control: ${controlDid.base}, runtime: ${runtimeDid.base}).`
      );
      fixes.push(
        `Set TENANTMAP_PREFIX=${controlDid.base} in runtime env or update control-plane DID keys to ${runtimeDid.base}.`
      );
    }

    if (!controlDid.suffix || !runtimeDid.suffix) {
      mismatches.push(
        `Unable to determine DID suffix (control: ${controlDid.suffix ?? "unknown"}, runtime: ${runtimeDid.suffix ?? "unknown"}).`
      );
      fixes.push("Ensure both reports document DID key formats with the \":did:\" suffix.");
    } else if (controlDid.suffix !== runtimeDid.suffix) {
      mismatches.push(
        `DID suffix mismatch (control: ${controlDid.suffix}, runtime: ${runtimeDid.suffix}).`
      );
      fixes.push("Align DID key suffix to \":did:\" in both control and runtime reports.");
    }

    const controlTenantCfg = parseTenantCfgParts(
      control.tenantCfgKeyFormat,
      control.tenantCfgPrefix
    );
    const runtimeTenantCfg = parseTenantCfgParts(
      runtime.tenantCfgKeyFormat,
      runtime.tenantCfgPrefix
    );

    if (!controlTenantCfg.base || !runtimeTenantCfg.base) {
      mismatches.push(
        `Unable to determine TENANTCFG_PREFIX base (control: ${controlTenantCfg.base ?? "unknown"}, runtime: ${runtimeTenantCfg.base ?? "unknown"}).`
      );
      fixes.push("Ensure both reports document TENANTCFG_PREFIX or tenant config key format.");
    } else if (controlTenantCfg.base !== runtimeTenantCfg.base) {
      mismatches.push(
        `TENANTCFG_PREFIX mismatch (control: ${controlTenantCfg.base}, runtime: ${runtimeTenantCfg.base}).`
      );
      fixes.push(
        `Set TENANTCFG_PREFIX=${controlTenantCfg.base} in runtime env or update control-plane tenantcfg prefix to ${runtimeTenantCfg.base}.`
      );
    }

    const controlDelimiter = controlTenantCfg.delimiter;
    const runtimeDelimiter = runtimeTenantCfg.delimiter;
    if (!controlDelimiter || !runtimeDelimiter) {
      mismatches.push(
        `Unable to determine tenantcfg delimiter (control: ${controlDelimiter ?? "unknown"}, runtime: ${runtimeDelimiter ?? "unknown"}).`
      );
      fixes.push("Ensure both reports document tenantcfg key formats with ':' delimiter.");
    } else if (controlDelimiter !== ":" || runtimeDelimiter !== ":") {
      mismatches.push(
        `Tenantcfg delimiter mismatch (control: ${controlDelimiter}, runtime: ${runtimeDelimiter}).`
      );
      fixes.push("Align tenantcfg key formats to use ':' between prefix and tenant id.");
    }

    const controlTokens = normalizationTokens(control.normalization);
    const runtimeTokens = normalizationTokens(runtime.normalization);
    const controlHasE164 = hasE164Token(controlTokens);
    const runtimeHasE164 = hasE164Token(runtimeTokens);

    if (!controlHasE164 || !runtimeHasE164) {
      mismatches.push(
        `DID normalization mismatch: E.164 must be enforced (control: ${formatNormalization(
          control.normalization
        )}, runtime: ${formatNormalization(runtime.normalization)}).`
      );
      fixes.push(
        "Ensure both reports indicate E.164 normalization for DID handling."
      );
    }

    const controlFields = control.requiredFields
      ? new Set(control.requiredFields)
      : undefined;
    const runtimeFields = runtime.requiredFields
      ? new Set(runtime.requiredFields)
      : undefined;
    const dropAltFields = (fields: Set<string> | undefined, alt: string[]) => {
      if (!fields) return fields;
      alt.forEach((group) => {
        group.split("|").forEach((field) => fields.delete(field));
      });
      return fields;
    };

    const normalizedControlFields = dropAltFields(
      controlFields,
      control.altRequiredGroups
    );
    const normalizedRuntimeFields = dropAltFields(
      runtimeFields,
      runtime.altRequiredGroups
    );
    if (!normalizedControlFields || !normalizedRuntimeFields) {
      mismatches.push(
        `Unable to determine required fields (control: ${formatSet(
          normalizedControlFields
        )}, runtime: ${formatSet(normalizedRuntimeFields)}).`
      );
      fixes.push(
        "Add explicit required field lists or JSON examples to both reports."
      );
    } else {
      const missingInRuntime = [...normalizedControlFields].filter(
        (field) => !normalizedRuntimeFields.has(field)
      );
      const extraInRuntime = [...normalizedRuntimeFields].filter(
        (field) => !normalizedControlFields.has(field)
      );
      if (missingInRuntime.length || extraInRuntime.length) {
        mismatches.push(
          `Required fields mismatch (missing in runtime: ${missingInRuntime.join(
            ", "
          ) || "none"}, extra in runtime: ${extraInRuntime.join(", ") || "none"}).`
        );
        fixes.push(
          `Align required fields to ${formatSet(normalizedControlFields)}.`
        );
      }
    }

    const controlAlt = new Set(control.altRequiredGroups);
    const runtimeAlt = new Set(runtime.altRequiredGroups);
    if (controlAlt.size || runtimeAlt.size) {
      const missingAlt = [...controlAlt].filter((g) => !runtimeAlt.has(g));
      const extraAlt = [...runtimeAlt].filter((g) => !controlAlt.has(g));
      if (missingAlt.length || extraAlt.length) {
        mismatches.push(
          `Alternative required fields mismatch (control: ${[...controlAlt].join(
            ", "
          ) || "none"}, runtime: ${[...runtimeAlt].join(", ") || "none"}).`
        );
        fixes.push(
          "Ensure optional-or-required field pairs match across reports."
        );
      }
    }

    if (!control.schemaVersion || !runtime.schemaVersion) {
      mismatches.push(
        `Unable to determine schema version (control: ${control.schemaVersion ?? "unknown"}, runtime: ${runtime.schemaVersion ?? "unknown"}).`
      );
      fixes.push(
        "Ensure both reports state the contractVersion/schema version explicitly."
      );
    } else if (control.schemaVersion !== runtime.schemaVersion) {
      mismatches.push(
        `Schema version mismatch (control: ${control.schemaVersion}, runtime: ${runtime.schemaVersion}).`
      );
      fixes.push(
        `Align contractVersion to ${control.schemaVersion} in runtime or update control-plane config writer.`
      );
    }
  }

  if (process.env.CHECK_CONTRACT_DEBUG === "1") {
    const debugControl = parseDidMappingParts(
      control.didKeyFormat,
      control.didPrefix
    );
    const debugRuntime = parseDidMappingParts(
      runtime.didKeyFormat,
      runtime.didPrefix,
      ":did:"
    );
    const debugControlCfg = parseTenantCfgParts(
      control.tenantCfgKeyFormat,
      control.tenantCfgPrefix
    );
    const debugRuntimeCfg = parseTenantCfgParts(
      runtime.tenantCfgKeyFormat,
      runtime.tenantCfgPrefix
    );
    console.log("CHECK_CONTRACT_DEBUG=1 parsed values:");
    console.log(
      JSON.stringify(
        {
          control: {
            didKeyFormat: control.didKeyFormat,
            didPrefix: control.didPrefix,
            didBase: debugControl.base,
            didSuffix: debugControl.suffix,
            tenantCfgKeyFormat: control.tenantCfgKeyFormat,
            tenantCfgPrefix: control.tenantCfgPrefix,
            tenantCfgBase: debugControlCfg.base,
            tenantCfgDelimiter: debugControlCfg.delimiter,
            schemaVersion: control.schemaVersion,
            requiredFields: formatSet(control.requiredFields),
            altRequiredGroups: control.altRequiredGroups,
            normalization: formatNormalization(control.normalization),
          },
          runtime: {
            didKeyFormat: runtime.didKeyFormat,
            didPrefix: runtime.didPrefix,
            didBase: debugRuntime.base,
            didSuffix: debugRuntime.suffix,
            tenantCfgKeyFormat: runtime.tenantCfgKeyFormat,
            tenantCfgPrefix: runtime.tenantCfgPrefix,
            tenantCfgBase: debugRuntimeCfg.base,
            tenantCfgDelimiter: debugRuntimeCfg.delimiter,
            schemaVersion: runtime.schemaVersion,
            requiredFields: formatSet(runtime.requiredFields),
            altRequiredGroups: runtime.altRequiredGroups,
            normalization: formatNormalization(runtime.normalization),
          },
        },
        null,
        2
      )
    );
  }

  const compatible = mismatches.length === 0;
  console.log(compatible ? "✅ Compatible" : "❌ Not Compatible");
  if (!compatible) {
    console.log("\nMismatches:");
    mismatches.forEach((mismatch) => console.log(`- ${mismatch}`));
    console.log("\nSuggested fixes:");
    fixes.forEach((fix) => console.log(`- ${fix}`));
  }

  process.exit(compatible ? 0 : 1);
}

function runSelfTest() {
  const control = parseDidMappingParts("tenantmap:did:{{DID_E164}}");
  assert.equal(control.base, "tenantmap");
  assert.equal(control.suffix, ":did:");

  const runtimeEnv = parseDidMappingParts(undefined, "tenantmap", ":did:");
  assert.equal(runtimeEnv.base, "tenantmap");
  assert.equal(runtimeEnv.suffix, ":did:");

  const runtimeFull = parseDidMappingParts("foo:did:{{DID_E164}}");
  assert.equal(runtimeFull.base, "foo");
  assert.equal(runtimeFull.suffix, ":did:");

  const runtimePrefixWithSuffix = parseDidMappingParts(undefined, "tenantmap:did:");
  assert.equal(runtimePrefixWithSuffix.base, "tenantmap");
  assert.equal(runtimePrefixWithSuffix.suffix, ":did:");

  const runtimePlaceholder = parseDidMappingParts(
    "{{TENANTMAP_PREFIX}}:did:{{DID_E164}}",
    "tenantmap",
    ":did:"
  );
  assert.equal(runtimePlaceholder.base, "tenantmap");
  assert.equal(runtimePlaceholder.suffix, ":did:");

  const tenantCfgControl = parseTenantCfgParts("tenantcfg:{{TENANT_ID}}");
  assert.equal(tenantCfgControl.base, "tenantcfg");
  assert.equal(tenantCfgControl.delimiter, ":");

  const tenantCfgRuntime = parseTenantCfgParts(
    "${TENANTCFG_PREFIX}:${tenantId}",
    "tenantcfg"
  );
  assert.equal(tenantCfgRuntime.base, "tenantcfg");
  assert.equal(tenantCfgRuntime.delimiter, ":");

  const runtimeContent = `
## Redis-related environment variables
- \`TENANTMAP_PREFIX\` (default \`tenantmap\` when missing/blank)
- \`TENANTCFG_PREFIX\` (default \`tenantcfg\` when missing/blank)

## Tenant DID -> tenantId mapping
- Key format: \`\${TENANTMAP_PREFIX}:did:\${normalized}\`
- Normalization: \`toNumber.trim().replace(/\\s+/g, '')\`

## Tenant runtime config (tenantcfg)
- Key format: \`\${TENANTCFG_PREFIX}:\${tenantId}\`
- Schema version: \`contractVersion: "v1"\`
`;

  const runtimeDidKeyFormat = extractRuntimeKeyFormat(
    runtimeContent,
    /Tenant DID -> tenantId mapping/i,
    /Key format:\s*`(\$\{TENANTMAP_PREFIX\}:did:\$\{normalized\})`/i
  );
  assert.equal(
    runtimeDidKeyFormat,
    "${TENANTMAP_PREFIX}:did:${normalized}"
  );
  const runtimeTenantCfgKeyFormat = extractRuntimeKeyFormat(
    runtimeContent,
    /Tenant runtime config/i,
    /Key format:\s*`(\$\{TENANTCFG_PREFIX\}:\$\{tenantId\})`/i
  );
  assert.equal(
    runtimeTenantCfgKeyFormat,
    "${TENANTCFG_PREFIX}:${tenantId}"
  );
  assert.equal(
    extractRuntimeDefaultPrefix(runtimeContent, "TENANTMAP_PREFIX", "tenantmap"),
    "tenantmap"
  );
  assert.equal(
    extractRuntimeDefaultPrefix(runtimeContent, "TENANTCFG_PREFIX", "tenantcfg"),
    "tenantcfg"
  );
  assert.equal(extractSchemaVersionFromText(runtimeContent), "v1");

  const normalization = buildNormalizationInfoFromValue(
    "toNumber.trim().replace(/\\s+/g, '')"
  );
  assert.equal(normalization.trim, true);
  assert.equal(normalization.whitespace, true);
}

if (process.env.NODE_ENV === "test") {
  runSelfTest();
} else {
  main();
}
