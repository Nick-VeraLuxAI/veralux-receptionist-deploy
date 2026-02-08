#!/usr/bin/env node
/* eslint-disable no-console */

const { TextEncoder } = require("util");

// Usage:
//   ADMIN_JWT_SECRET=... ADMIN_JWT_ISSUER=local ADMIN_JWT_AUDIENCE=local \
//   node scripts/gen_dev_jwt.js user-1 admin user1@test.com

async function main() {
  const sub = process.argv[2];
  const role = process.argv[3] || "admin";
  const email = process.argv[4] || `${sub}@test.com`;

  if (!sub) {
    console.error("Usage: node scripts/gen_dev_jwt.js <sub> [role] [email]");
    process.exit(1);
  }

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    console.error("ADMIN_JWT_SECRET is required");
    process.exit(1);
  }

  const iss = process.env.ADMIN_JWT_ISSUER || "local";
  const aud = process.env.ADMIN_JWT_AUDIENCE || "local";

  // 🔐 Force REAL runtime ESM import (prevents require() crash)
  const importer = new Function("m", "return import(m)");
  const { SignJWT } = await importer("jose");

  const token = await new SignJWT({
    role,
    email,
    name: email.split("@")[0],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)          // ✅ THIS IS THE FIX
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  console.log(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
