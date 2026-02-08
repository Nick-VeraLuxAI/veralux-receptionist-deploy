/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://veralux:veralux@localhost:5432/veralux";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const DOWN_MARKER = /^--\s*@down\b/im;

function parseMigration(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parts = raw.split(DOWN_MARKER);
  const up = parts[0].trim();
  const down = parts[1] ? parts[1].trim() : "";
  return { up, down };
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz default now()
    );
  `);
}

async function getApplied(client) {
  const res = await client.query("select id from schema_migrations order by id asc");
  return new Set(res.rows.map((r) => r.id));
}

async function migrateUp(pool) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const { up } = parseMigration(path.join(MIGRATIONS_DIR, file));
      if (!up) continue;
      console.log(`Applying ${file}...`);
      await client.query("begin");
      await client.query(up);
      await client.query("insert into schema_migrations (id) values ($1)", [file]);
      await client.query("commit");
    }
    console.log("Migrations up to date.");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function migrateDown(pool, steps = 1) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const res = await client.query(
      "select id from schema_migrations order by applied_at desc, id desc"
    );
    const applied = res.rows.map((r) => r.id);
    const target = applied.slice(0, steps);
    if (target.length === 0) {
      console.log("No migrations to roll back.");
      return;
    }
    for (const file of target) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Migration file not found for rollback: ${file}`);
      }
      const { down } = parseMigration(filePath);
      console.log(`Rolling back ${file}...`);
      await client.query("begin");
      if (down) {
        await client.query(down);
      }
      await client.query("delete from schema_migrations where id = $1", [file]);
      await client.query("commit");
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function status(pool) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    console.log("Status:");
    for (const file of files) {
      console.log(`${applied.has(file) ? "[x]" : "[ ]"} ${file}`);
    }
  } finally {
    client.release();
  }
}

async function main() {
  const cmd = process.argv[2] || "up";
  const steps = Number(process.argv[3]) || 1;
  const pool = new Pool({ connectionString: DEFAULT_DATABASE_URL });
  try {
    if (cmd === "up") {
      await migrateUp(pool);
    } else if (cmd === "down" || cmd === "rollback") {
      await migrateDown(pool, steps);
    } else if (cmd === "status") {
      await status(pool);
    } else {
      console.error("Unknown command. Use up|down|status");
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
