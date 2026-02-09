#!/usr/bin/env node
/**
 * Wait for Postgres to accept connections (for Docker entrypoint).
 * Uses DATABASE_URL; exits 0 when ready, 1 after max retries.
 */
const { Client } = require("pg");

const url = process.env.DATABASE_URL || "postgres://veralux:veralux@postgres:5432/veralux";
const maxAttempts = 90;
const delayMs = 2000;

async function wait() {
  // Mask password in log output
  const safeUrl = url.replace(/:([^@]+)@/, ':***@');
  console.log("[wait-for-db] Connecting to:", safeUrl);
  
  let lastError = "";
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.end();
      console.log("[wait-for-db] Postgres is ready.");
      process.exit(0);
    } catch (err) {
      lastError = err.message || String(err);
      if (i === 0) {
        process.stderr.write("[wait-for-db] Waiting for Postgres");
      }
      process.stderr.write(".");
      if (i % 10 === 9) {
        process.stderr.write("\n[wait-for-db] Still waiting... last error: " + lastError + "\n");
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("\n[wait-for-db] Postgres did not become ready in time.");
  console.error("[wait-for-db] Last error: " + lastError);
  process.exit(1);
}

wait();
