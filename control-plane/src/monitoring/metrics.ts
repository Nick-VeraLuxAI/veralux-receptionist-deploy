/**
 * Prometheus-compatible metrics endpoint.
 *
 * Exposes per-tenant and system-wide metrics in text/plain format
 * that Prometheus can scrape.
 */

import { pool } from "../db";

// ── In-memory counters (thread-safe via single-threaded Node.js) ─────

interface Gauge {
  value: number;
  labels: Record<string, string>;
}

interface Counter {
  value: number;
  labels: Record<string, string>;
}

const gauges: Map<string, Gauge[]> = new Map();
const counters: Map<string, Counter[]> = new Map();

function findOrCreate<T extends { labels: Record<string, string> }>(
  map: Map<string, T[]>,
  name: string,
  labels: Record<string, string>,
  defaultValue: number
): T {
  let arr = map.get(name);
  if (!arr) {
    arr = [];
    map.set(name, arr);
  }
  const existing = arr.find((item) =>
    Object.keys(labels).every((k) => item.labels[k] === labels[k])
  );
  if (existing) return existing;
  const entry = { value: defaultValue, labels } as unknown as T;
  arr.push(entry);
  return entry;
}

// ── Public API ───────────────────────────────────────

export function setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
  const entry = findOrCreate(gauges, name, labels, 0);
  entry.value = value;
}

export function incrementCounter(name: string, amount: number = 1, labels: Record<string, string> = {}): void {
  const entry = findOrCreate(counters, name, labels, 0);
  entry.value += amount;
}

// ── Metrics Collection ───────────────────────────────

async function collectDatabaseMetrics(): Promise<string[]> {
  const lines: string[] = [];
  const client = await pool.connect();
  try {
    // Total tenants
    const tenantCount = await client.query("SELECT COUNT(*) as cnt FROM tenants");
    lines.push(`# HELP veralux_tenants_total Total number of registered tenants`);
    lines.push(`# TYPE veralux_tenants_total gauge`);
    lines.push(`veralux_tenants_total ${tenantCount.rows[0].cnt}`);

    // Active subscriptions by status
    const subsByStatus = await client.query(
      "SELECT COALESCE(status, 'none') as status, COUNT(*) as cnt FROM tenant_subscriptions GROUP BY status"
    );
    lines.push(`# HELP veralux_subscriptions Subscriptions by status`);
    lines.push(`# TYPE veralux_subscriptions gauge`);
    for (const row of subsByStatus.rows) {
      lines.push(`veralux_subscriptions{status="${row.status}"} ${row.cnt}`);
    }

    // Total leads
    const leadCount = await client.query("SELECT COUNT(*) as cnt FROM leads");
    lines.push(`# HELP veralux_leads_total Total leads captured`);
    lines.push(`# TYPE veralux_leads_total gauge`);
    lines.push(`veralux_leads_total ${leadCount.rows[0].cnt}`);

    // Workflow runs by status
    const runsByStatus = await client.query(
      "SELECT status, COUNT(*) as cnt FROM workflow_runs GROUP BY status"
    );
    lines.push(`# HELP veralux_workflow_runs Workflow runs by status`);
    lines.push(`# TYPE veralux_workflow_runs gauge`);
    for (const row of runsByStatus.rows) {
      lines.push(`veralux_workflow_runs{status="${row.status}"} ${row.cnt}`);
    }

    // Current month usage per tenant (top 20)
    const period = new Date().toISOString().slice(0, 7);
    const usageRes = await client.query(
      `SELECT tenant_id, call_count, call_minutes, api_requests
       FROM tenant_usage
       WHERE period = $1
       ORDER BY call_count DESC
       LIMIT 20`,
      [period]
    );
    lines.push(`# HELP veralux_tenant_calls_total Calls this month per tenant`);
    lines.push(`# TYPE veralux_tenant_calls_total gauge`);
    lines.push(`# HELP veralux_tenant_call_minutes Call minutes this month per tenant`);
    lines.push(`# TYPE veralux_tenant_call_minutes gauge`);
    lines.push(`# HELP veralux_tenant_api_requests API requests this month per tenant`);
    lines.push(`# TYPE veralux_tenant_api_requests gauge`);
    for (const row of usageRes.rows) {
      const tid = row.tenant_id;
      lines.push(`veralux_tenant_calls_total{tenant="${tid}"} ${row.call_count || 0}`);
      lines.push(`veralux_tenant_call_minutes{tenant="${tid}"} ${row.call_minutes || 0}`);
      lines.push(`veralux_tenant_api_requests{tenant="${tid}"} ${row.api_requests || 0}`);
    }

    // Database connection pool stats
    lines.push(`# HELP veralux_db_pool_total Total connections in pool`);
    lines.push(`# TYPE veralux_db_pool_total gauge`);
    lines.push(`veralux_db_pool_total ${pool.totalCount}`);
    lines.push(`# HELP veralux_db_pool_idle Idle connections in pool`);
    lines.push(`# TYPE veralux_db_pool_idle gauge`);
    lines.push(`veralux_db_pool_idle ${pool.idleCount}`);
    lines.push(`# HELP veralux_db_pool_waiting Waiting clients in pool`);
    lines.push(`# TYPE veralux_db_pool_waiting gauge`);
    lines.push(`veralux_db_pool_waiting ${pool.waitingCount}`);

  } catch (err) {
    lines.push(`# Error collecting DB metrics: ${(err as Error).message}`);
  } finally {
    client.release();
  }
  return lines;
}

function collectInMemoryMetrics(): string[] {
  const lines: string[] = [];

  // Process metrics
  const mem = process.memoryUsage();
  lines.push(`# HELP veralux_process_heap_bytes Heap memory usage`);
  lines.push(`# TYPE veralux_process_heap_bytes gauge`);
  lines.push(`veralux_process_heap_bytes ${mem.heapUsed}`);
  lines.push(`# HELP veralux_process_rss_bytes Resident set size`);
  lines.push(`# TYPE veralux_process_rss_bytes gauge`);
  lines.push(`veralux_process_rss_bytes ${mem.rss}`);
  lines.push(`# HELP veralux_process_uptime_seconds Process uptime`);
  lines.push(`# TYPE veralux_process_uptime_seconds gauge`);
  lines.push(`veralux_process_uptime_seconds ${Math.floor(process.uptime())}`);

  // In-memory gauges
  for (const [name, entries] of gauges) {
    lines.push(`# TYPE ${name} gauge`);
    for (const entry of entries) {
      const labelStr = Object.entries(entry.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${entry.value}`);
    }
  }

  // In-memory counters
  for (const [name, entries] of counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const entry of entries) {
      const labelStr = Object.entries(entry.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${entry.value}`);
    }
  }

  return lines;
}

/**
 * Generate Prometheus-format metrics text.
 */
export async function generateMetrics(): Promise<string> {
  const inMemory = collectInMemoryMetrics();
  const db = await collectDatabaseMetrics();

  return [...inMemory, ...db].join("\n") + "\n";
}

// ── Health Dashboard Data ────────────────────────────

export interface SystemHealth {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  memory: { heapUsed: number; rss: number; heapTotal: number };
  database: { connected: boolean; poolSize: number; idle: number; waiting: number };
  tenants: { total: number; active: number };
  callsToday: number;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const client = await pool.connect();
  try {
    let dbConnected = true;
    let tenantTotal = 0;
    let tenantActive = 0;
    let callsToday = 0;

    try {
      const tc = await client.query("SELECT COUNT(*) as cnt FROM tenants");
      tenantTotal = parseInt(tc.rows[0].cnt);

      const ac = await client.query(
        "SELECT COUNT(*) as cnt FROM tenant_subscriptions WHERE status IN ('active', 'trialing', 'trial')"
      );
      tenantActive = parseInt(ac.rows[0].cnt);

      const today = new Date().toISOString().slice(0, 10);
      const cc = await client.query(
        "SELECT COALESCE(SUM(call_count), 0) as cnt FROM tenant_usage WHERE period = $1",
        [today.slice(0, 7)]
      );
      callsToday = parseInt(cc.rows[0].cnt);
    } catch {
      dbConnected = false;
    }

    const mem = process.memoryUsage();
    const dbOk = dbConnected && pool.waitingCount < 10;

    return {
      status: dbOk ? "healthy" : "degraded",
      uptime: Math.floor(process.uptime()),
      memory: { heapUsed: mem.heapUsed, rss: mem.rss, heapTotal: mem.heapTotal },
      database: {
        connected: dbConnected,
        poolSize: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      tenants: { total: tenantTotal, active: tenantActive },
      callsToday,
    };
  } finally {
    client.release();
  }
}
