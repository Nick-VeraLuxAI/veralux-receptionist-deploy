#!/usr/bin/env node
/**
 * Wait for Postgres to accept connections (for Docker entrypoint).
 * Uses DATABASE_URL; exits 0 when ready, 1 after max retries.
 */
const { Client } = require("pg");

const url = process.env.DATABASE_URL || "postgres://veralux:veralux@db:5432/veralux";
const maxAttempts = 60;
const delayMs = 1000;

async function wait() {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.end();
      console.log("[wait-for-db] Postgres is ready.");
      process.exit(0);
    } catch (err) {
      if (i === 0) process.stderr.write("[wait-for-db] Waiting for Postgres");
      process.stderr.write(".");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("\n[wait-for-db] Postgres did not become ready in time.");
  process.exit(1);
}

wait();
