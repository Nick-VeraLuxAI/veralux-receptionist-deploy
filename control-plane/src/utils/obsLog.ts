// src/utils/obsLog.ts
type Json = Record<string, unknown>;

export function obsLog(event: string, fields: Json = {}) {
  // One-line JSON logs (easy to grep + ship to any log system later)
  const payload = {
    ts: new Date().toISOString(),
    level: "info",
    event,
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export function obsWarn(event: string, fields: Json = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level: "warn",
    event,
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify(payload));
}
