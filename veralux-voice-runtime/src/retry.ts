import { log } from './log';

/**
 * Retry a fetch-like async operation with short exponential backoff.
 * Only retries on transient errors (5xx, timeouts, connection resets).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; retries?: number; baseDelayMs?: number } = { label: 'fetch' },
): Promise<T> {
  const maxRetries = opts.retries ?? 1;
  const baseDelay = opts.baseDelayMs ?? 250;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt >= maxRetries || !isTransient(err)) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      log.warn(
        { event: 'retry', label: opts.label, attempt: attempt + 1, maxRetries, delayMs: delay },
        `${opts.label} transient error, retrying`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('abort')) {
      return true;
    }
    if (/\b5\d{2}\b/.test(msg)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
