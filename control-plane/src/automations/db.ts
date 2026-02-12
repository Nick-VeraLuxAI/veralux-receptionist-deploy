/**
 * Database helpers for the workflow automation engine.
 */

import { pool } from "../db";
import type {
  Workflow, WorkflowRun, Lead, RunStatus,
  TriggerType, TriggerConfig, WorkflowStep, WorkflowSettings,
} from "./types";

// ── Row mappers ──────────────────────────────────

function rowToWorkflow(r: any): Workflow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    enabled: r.enabled,
    triggerType: r.trigger_type as TriggerType,
    triggerConfig: r.trigger_config ?? {},
    steps: r.steps ?? [],
    createdBy: r.created_by,
    adminLocked: r.admin_locked,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

function rowToRun(r: any): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    tenantId: r.tenant_id,
    triggerEvent: r.trigger_event ?? {},
    status: r.status as RunStatus,
    stepsCompleted: r.steps_completed,
    stepsTotal: r.steps_total,
    result: r.result ?? [],
    error: r.error ?? null,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
  };
}

function rowToLead(r: any): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    callId: r.call_id ?? null,
    name: r.name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    issue: r.issue ?? null,
    category: r.category ?? null,
    priority: r.priority ?? "normal",
    notes: r.notes ?? null,
    rawExtract: r.raw_extract ?? null,
    sourceWorkflowId: r.source_workflow_id ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  };
}

// ── Workflows CRUD ───────────────────────────────

export async function listWorkflows(tenantId: string): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId]
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}

export async function getWorkflow(id: string, tenantId?: string): Promise<Workflow | null> {
  const client = await pool.connect();
  try {
    const sql = tenantId
      ? "SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2"
      : "SELECT * FROM workflows WHERE id = $1";
    const params = tenantId ? [id, tenantId] : [id];
    const res = await client.query(sql, params);
    return res.rows[0] ? rowToWorkflow(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function getEnabledWorkflowsByTrigger(
  tenantId: string,
  triggerType: TriggerType
): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE tenant_id = $1 AND trigger_type = $2 AND enabled = true",
      [tenantId, triggerType]
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}

export async function createWorkflow(params: {
  tenantId: string;
  name: string;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig;
  steps: WorkflowStep[];
  createdBy?: string;
  adminLocked?: boolean;
}): Promise<Workflow> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO workflows (tenant_id, name, trigger_type, trigger_config, steps, created_by, admin_locked)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.tenantId,
        params.name,
        params.triggerType,
        JSON.stringify(params.triggerConfig),
        JSON.stringify(params.steps),
        params.createdBy ?? "admin",
        params.adminLocked ?? false,
      ]
    );
    return rowToWorkflow(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function updateWorkflow(
  id: string,
  data: Partial<Pick<Workflow, "name" | "enabled" | "triggerType" | "triggerConfig" | "steps" | "adminLocked">>,
  tenantId?: string
): Promise<Workflow | null> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(data.enabled); }
  if (data.triggerType !== undefined) { sets.push(`trigger_type = $${idx++}`); vals.push(data.triggerType); }
  if (data.triggerConfig !== undefined) { sets.push(`trigger_config = $${idx++}`); vals.push(JSON.stringify(data.triggerConfig)); }
  if (data.steps !== undefined) { sets.push(`steps = $${idx++}`); vals.push(JSON.stringify(data.steps)); }
  if (data.adminLocked !== undefined) { sets.push(`admin_locked = $${idx++}`); vals.push(data.adminLocked); }

  if (sets.length === 0) return getWorkflow(id, tenantId);

  sets.push(`updated_at = now()`);
  vals.push(id);

  let whereClause = `WHERE id = $${idx}`;
  if (tenantId) {
    vals.push(tenantId);
    idx++;
    whereClause += ` AND tenant_id = $${idx}`;
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE workflows SET ${sets.join(", ")} ${whereClause} RETURNING *`,
      vals
    );
    return res.rows[0] ? rowToWorkflow(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function deleteWorkflow(id: string, tenantId?: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const sql = tenantId
      ? "DELETE FROM workflows WHERE id = $1 AND tenant_id = $2"
      : "DELETE FROM workflows WHERE id = $1";
    const params = tenantId ? [id, tenantId] : [id];
    const res = await client.query(sql, params);
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ── Workflow Runs ────────────────────────────────

export async function createRun(params: {
  workflowId: string;
  tenantId: string;
  triggerEvent: Record<string, any>;
  stepsTotal: number;
}): Promise<WorkflowRun> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO workflow_runs (workflow_id, tenant_id, trigger_event, status, steps_total)
       VALUES ($1, $2, $3, 'running', $4)
       RETURNING *`,
      [params.workflowId, params.tenantId, JSON.stringify(params.triggerEvent), params.stepsTotal]
    );
    return rowToRun(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function updateRun(
  id: string,
  data: Partial<Pick<WorkflowRun, "status" | "stepsCompleted" | "result" | "error">>,
  tenantId?: string
): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (data.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(data.status); }
  if (data.stepsCompleted !== undefined) { sets.push(`steps_completed = $${idx++}`); vals.push(data.stepsCompleted); }
  if (data.result !== undefined) { sets.push(`result = $${idx++}`); vals.push(JSON.stringify(data.result)); }
  if (data.error !== undefined) { sets.push(`error = $${idx++}`); vals.push(data.error); }

  if (data.status === "completed" || data.status === "failed") {
    sets.push(`completed_at = now()`);
  }

  if (sets.length === 0) return;

  vals.push(id);
  let whereClause = `WHERE id = $${idx}`;
  if (tenantId) {
    idx++;
    vals.push(tenantId);
    whereClause += ` AND tenant_id = $${idx}`;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE workflow_runs SET ${sets.join(", ")} ${whereClause}`,
      vals
    );
  } finally {
    client.release();
  }
}

export async function listRuns(
  tenantId: string,
  limit = 50
): Promise<WorkflowRun[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflow_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2",
      [tenantId, limit]
    );
    return res.rows.map(rowToRun);
  } finally {
    client.release();
  }
}

// ── Leads ────────────────────────────────────────

export async function createLead(params: {
  tenantId: string;
  callId?: string;
  name?: string;
  phone?: string;
  email?: string;
  issue?: string;
  category?: string;
  priority?: string;
  notes?: string;
  rawExtract?: Record<string, any>;
  sourceWorkflowId?: string;
}): Promise<Lead> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO leads (tenant_id, call_id, name, phone, email, issue, category, priority, notes, raw_extract, source_workflow_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        params.tenantId,
        params.callId ?? null,
        params.name ?? null,
        params.phone ?? null,
        params.email ?? null,
        params.issue ?? null,
        params.category ?? null,
        params.priority ?? "normal",
        params.notes ?? null,
        params.rawExtract ? JSON.stringify(params.rawExtract) : null,
        params.sourceWorkflowId ?? null,
      ]
    );
    return rowToLead(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function listLeads(
  tenantId: string,
  limit = 100
): Promise<Lead[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2",
      [tenantId, limit]
    );
    return res.rows.map(rowToLead);
  } finally {
    client.release();
  }
}

export async function deleteLead(id: string, tenantId?: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const sql = tenantId
      ? "DELETE FROM leads WHERE id = $1 AND tenant_id = $2"
      : "DELETE FROM leads WHERE id = $1";
    const params = tenantId ? [id, tenantId] : [id];
    const res = await client.query(sql, params);
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ── Workflow Settings ────────────────────────────

export async function getWorkflowSettings(tenantId: string): Promise<WorkflowSettings> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT workflow_settings FROM tenant_configs WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0]?.workflow_settings ?? { ownerCanEdit: false };
  } finally {
    client.release();
  }
}

export async function updateWorkflowSettings(
  tenantId: string,
  settings: Partial<WorkflowSettings>
): Promise<WorkflowSettings> {
  const client = await pool.connect();
  try {
    const current = await getWorkflowSettings(tenantId);
    const merged = { ...current, ...settings };
    await client.query(
      `UPDATE tenant_configs SET workflow_settings = $2 WHERE tenant_id = $1`,
      [tenantId, JSON.stringify(merged)]
    );
    return merged;
  } finally {
    client.release();
  }
}

// ── Scheduled workflows ─────────────────────────

export async function getScheduledWorkflows(): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE trigger_type = 'scheduled' AND enabled = true"
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}
