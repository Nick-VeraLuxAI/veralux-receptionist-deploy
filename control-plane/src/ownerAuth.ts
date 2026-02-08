/**
 * Owner authentication: phone-number + passcode login for business owners.
 *
 * Flow:
 *  1. Owner enters phone number → we resolve the tenant
 *  2. Owner enters passcode → we verify against owner_passcodes
 *  3. We issue a short-lived JWT scoped to that tenant
 *  4. The JWT is accepted by the existing adminGuard (OIDC/JWT path)
 *     which resolves tenant_memberships automatically
 */

import { createHash } from "crypto";
import {
  getOwnerPasscodeHash,
  upsertOwnerPasscode,
  upsertUserBySub,
  upsertTenantMembership,
} from "./db";

// ── Passcode hashing ────────────────────────────────

export function hashPasscode(passcode: string): string {
  return createHash("sha256").update(passcode.trim()).digest("hex");
}

export async function verifyOwnerPasscode(
  tenantId: string,
  passcode: string
): Promise<boolean> {
  const stored = await getOwnerPasscodeHash(tenantId);
  if (!stored) return false;
  return stored === hashPasscode(passcode);
}

export async function setOwnerPasscode(
  tenantId: string,
  passcode: string
): Promise<void> {
  await upsertOwnerPasscode(tenantId, hashPasscode(passcode));
}

// ── JWT signing ─────────────────────────────────────

async function getJose() {
  const importer = new Function("m", "return import(m)") as (
    m: string
  ) => Promise<any>;
  return (await importer("jose")) as typeof import("jose");
}

function getSigningSecret(): Uint8Array {
  const secret =
    process.env.ADMIN_JWT_SECRET ||
    process.env.JWT_SECRET ||
    "";
  if (!secret) {
    throw new Error("JWT_SECRET or ADMIN_JWT_SECRET must be set for owner auth");
  }
  return new TextEncoder().encode(secret);
}

export async function issueOwnerJwt(params: {
  tenantId: string;
  tenantName: string;
}): Promise<string> {
  const { SignJWT } = await getJose();
  const sub = `owner:${params.tenantId}`;

  // Ensure user + membership exist so adminGuard's JWT path works
  const user = await upsertUserBySub({
    idpSub: sub,
    email: `owner@${params.tenantId}`,
  });
  await upsertTenantMembership({
    tenantId: params.tenantId,
    userId: user.id,
    role: "admin",
  });

  const jwt = await new SignJWT({
    sub,
    role: "admin",
    name: params.tenantName,
    email: `owner@${params.tenantId}`,
    tenant_id: params.tenantId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSigningSecret());

  return jwt;
}
