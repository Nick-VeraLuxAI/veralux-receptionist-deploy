#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require("pg");
require("dotenv").config();

const TENANTS = [
  { id: "tenantA", name: "Tenant A" },
  { id: "tenantB", name: "Tenant B" },
];

const USERS = [
  { idp_sub: "user-1", email: "u1@test.com" },
  { idp_sub: "user-2", email: "u2@test.com" },
];

const MEMBERSHIPS = [
  { tenant_id: "tenantA", idp_sub: "user-1", role: "admin" },
  { tenant_id: "tenantA", idp_sub: "user-2", role: "admin" },
  { tenant_id: "tenantB", idp_sub: "user-2", role: "admin" },
];

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgres://veralux:veralux@127.0.0.1:5432/veralux",
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const t of TENANTS) {
      await client.query(
        `insert into tenants (id, name, created_at, updated_at)
         values ($1, $2, now(), now())
         on conflict (id) do update set name = excluded.name`,
        [t.id, t.name]
      );
    }
    const userIdMap = new Map();
    for (const u of USERS) {
      const res = await client.query(
        `insert into users (email, idp_sub, created_at)
         values ($1, $2, now())
         on conflict (idp_sub) do update set email = excluded.email
         returning id`,
        [u.email, u.idp_sub]
      );
      userIdMap.set(u.idp_sub, res.rows[0].id);
    }
    for (const m of MEMBERSHIPS) {
      const userId = userIdMap.get(m.idp_sub);
      await client.query(
        `insert into tenant_memberships (tenant_id, user_id, role, created_at)
         values ($1, $2, $3, now())
         on conflict (tenant_id, user_id) do update set role = excluded.role`,
        [m.tenant_id, userId, m.role]
      );
    }
    await client.query("commit");
    console.log("Seed complete for Stage 1 test.");
  } catch (err) {
    await client.query("rollback");
    console.error("Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
