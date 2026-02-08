import { createHash, randomBytes } from "crypto";
import {
  findAdminKeyByHash,
  insertAdminKey,
  listAdminKeys,
  deleteAdminKey,
  touchAdminKeyUsage,
  insertAuditLog,
} from "./db";

export type AdminRole = "admin" | "viewer";

export interface AdminPrincipal {
  id?: string; // db admin key id (undefined when env master key)
  name: string;
  role: AdminRole;
  source: "db" | "env" | "oidc";
  email?: string;
  idpSub?: string; // IMPORTANT: JWT subject, not DB user id
}

// jose types via import("jose") so we never load jose at module init
type JWTPayload = import("jose").JWTPayload;
type JWTVerifyOptions = import("jose").JWTVerifyOptions;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function looksLikeJwt(token: string) {
  return token.split(".").length === 3;
}

// ── JWT / OIDC helpers ───────────────────────────

const OIDC_ISSUER = process.env.ADMIN_JWT_ISSUER || undefined;
const OIDC_AUDIENCE = process.env.ADMIN_JWT_AUDIENCE || undefined;
const OIDC_JWKS_URL = process.env.ADMIN_JWKS_URL || undefined;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || undefined; // HS256 dev

let joseModule: typeof import("jose") | null = null;
// NOTE: keep jwks untyped to avoid jose typing/version surface mismatches
let jwks: any | null = null;

async function getJose() {
  if (joseModule) return joseModule;

  // Force a true runtime dynamic import so ts-node-dev/tsc can't rewrite it to require()
  const importer = new Function("m", "return import(m)") as (m: string) => Promise<any>;
  joseModule = (await importer("jose")) as typeof import("jose");

  return joseModule;
}

function getJwtVerifyOptions(): JWTVerifyOptions {
  const opts: JWTVerifyOptions = {};
  if (OIDC_ISSUER) opts.issuer = OIDC_ISSUER;
  if (OIDC_AUDIENCE) opts.audience = OIDC_AUDIENCE;
  return opts;
}

async function verifyJwtWithJwks(token: string): Promise<JWTPayload | undefined> {
  if (!OIDC_JWKS_URL) return undefined;

  const { createRemoteJWKSet, jwtVerify } = await getJose();
  if (!jwks) jwks = createRemoteJWKSet(new URL(OIDC_JWKS_URL));

  try {
    const { payload } = await jwtVerify(token, jwks, getJwtVerifyOptions());
    return payload;
  } catch {
    return undefined;
  }
}

async function verifyJwtWithSecret(token: string): Promise<JWTPayload | undefined> {
  if (!ADMIN_JWT_SECRET) return undefined;

  const { jwtVerify } = await getJose();
  const secret = new TextEncoder().encode(ADMIN_JWT_SECRET);

  try {
    const { payload } = await jwtVerify(token, secret, getJwtVerifyOptions());
    return payload;
  } catch {
    return undefined;
  }
}

async function authenticateAdminJwt(
  rawToken: string
): Promise<AdminPrincipal | undefined> {
  if (!looksLikeJwt(rawToken)) return undefined;

  // Prefer JWKS (real IdP), fall back to HS (dev)
  const payload =
    (await verifyJwtWithJwks(rawToken)) || (await verifyJwtWithSecret(rawToken));

  if (!payload) return undefined;

  const role: AdminRole =
    typeof (payload as any).role === "string" && (payload as any).role === "viewer"
      ? "viewer"
      : "admin";

  return {
    idpSub: typeof payload.sub === "string" ? payload.sub : undefined,
    name:
      (typeof (payload as any).name === "string" && (payload as any).name) ||
      (typeof (payload as any).email === "string" && (payload as any).email) ||
      "oidc-user",
    email: typeof (payload as any).email === "string" ? (payload as any).email : undefined,
    role,
    source: "oidc",
  };
}

export async function authenticateAdminKey(
  rawToken: string
): Promise<AdminPrincipal | undefined> {
  const mode = (process.env.ADMIN_AUTH_MODE || "hybrid").toLowerCase();

  // Try JWT only if it looks like JWT
  const jwtPrincipal = await authenticateAdminJwt(rawToken);
  if (jwtPrincipal) return jwtPrincipal;

  if (mode === "jwt-only") return undefined;

  // Fallback: master key
  const master = (process.env.ADMIN_API_KEY || process.env.VERALUX_ADMIN_KEY || "").trim();
  if (master && rawToken === master) {
    return { name: "master-key", role: "admin", source: "env" };
  }

  // DB-backed API key
  const hash = hashToken(rawToken);
  const key = await findAdminKeyByHash(hash);
  if (!key) return undefined;

  await touchAdminKeyUsage(key.id);
  return {
    id: key.id,
    name: key.name,
    role: (key.role as AdminRole) || "admin",
    source: "db",
  };
}

export async function createAdminKey(name: string, role: AdminRole = "admin") {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = await insertAdminKey({ name, role, tokenHash });
  return { id, token, name, role };
}

export async function listAdminKeySummaries() {
  return listAdminKeys();
}

export async function revokeAdminKey(id: string) {
  await deleteAdminKey(id);
}

export async function recordAudit(params: {
  adminKeyId?: string;
  action: string;
  path?: string;
  tenantId?: string;
  status?: string;
}) {
  await insertAuditLog(params);
}
