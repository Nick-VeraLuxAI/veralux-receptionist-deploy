/**
 * Scheduled trigger loop.
 * Periodically checks for scheduled workflows and fires them based on cron expressions.
 */

import { getScheduledWorkflows } from "./db";
import { handleScheduledTrigger } from "./eventBus";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const lastFiredMap = new Map<string, number>();

/**
 * Simple cron-like matcher.
 * Supports: "* * * * *" format (minute hour dayOfMonth month dayOfWeek)
 * Also supports "@hourly", "@daily", "@weekly", "@monthly".
 */
function matchesCron(expression: string, date: Date): boolean {
  // Handle named shortcuts
  const shortcuts: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@every5min": "*/5 * * * *",
    "@every15min": "*/15 * * * *",
    "@every30min": "*/30 * * * *",
  };

  const cron = shortcuts[expression] ?? expression;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  const values = [minute, hour, dayOfMonth, month, dayOfWeek];

  for (let i = 0; i < 5; i++) {
    if (!matchesCronField(parts[i], values[i], i)) return false;
  }

  return true;
}

function matchesCronField(field: string, value: number, _fieldIndex: number): boolean {
  if (field === "*") return true;

  // Handle step values like */5
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values like 1,2,3
  if (field.includes(",")) {
    return field.split(",").some(f => matchesCronField(f.trim(), value, _fieldIndex));
  }

  // Handle ranges like 1-5
  if (field.includes("-")) {
    const [min, max] = field.split("-").map(Number);
    return !isNaN(min) && !isNaN(max) && value >= min && value <= max;
  }

  // Exact match
  return parseInt(field) === value;
}

/**
 * Check all scheduled workflows and fire any that match the current time.
 */
async function checkSchedules(): Promise<void> {
  try {
    const workflows = await getScheduledWorkflows();
    const now = new Date();

    for (const wf of workflows) {
      const cronExpr = wf.triggerConfig.cronExpression;
      if (!cronExpr) continue;

      // Get timezone-adjusted date
      const tz = wf.triggerConfig.timezone ?? "America/New_York";
      let adjustedDate: Date;
      try {
        const tzStr = now.toLocaleString("en-US", { timeZone: tz });
        adjustedDate = new Date(tzStr);
      } catch {
        adjustedDate = now;
      }

      if (matchesCron(cronExpr, adjustedDate)) {
        // Prevent double-firing within the same minute
        const fireKey = `${wf.id}:${adjustedDate.getFullYear()}-${adjustedDate.getMonth()}-${adjustedDate.getDate()}-${adjustedDate.getHours()}-${adjustedDate.getMinutes()}`;
        if (lastFiredMap.has(fireKey)) continue;
        lastFiredMap.set(fireKey, Date.now());

        console.log(`[scheduler] Firing scheduled workflow "${wf.name}" (${wf.id})`);
        await handleScheduledTrigger(wf.tenantId, wf.id);
      }
    }

    // Clean old fire keys (keep only last hour)
    const oneHourAgo = Date.now() - 3600000;
    for (const [key, ts] of lastFiredMap) {
      if (ts < oneHourAgo) lastFiredMap.delete(key);
    }
  } catch (err) {
    console.error("[scheduler] Error checking schedules:", err);
  }
}

/**
 * Start the scheduler loop. Checks every 30 seconds.
 */
export function startScheduler(intervalMs = 30_000): void {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(checkSchedules, intervalMs);
  console.log("[scheduler] Started (checking every " + (intervalMs / 1000) + "s)");
  // Run immediately on start
  checkSchedules();
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[scheduler] Stopped");
  }
}
