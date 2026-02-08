import type { Request, Response, NextFunction } from "express";
import { tryAcquireLimit, getRemainingLimit } from "./redis";

const RATE_LIMIT_KEY_PREFIX = "ratelimit:admin:";

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
  /** When true, use Redis (if REDIS_URL set) so limits are shared across instances. Default false. */
  useRedis?: boolean;
}

/**
 * Sets standard rate limit headers on the response
 */
function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetMs: number
): void {
  res.setHeader("X-RateLimit-Limit", limit);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
  res.setHeader("X-RateLimit-Reset", Math.ceil((Date.now() + resetMs) / 1000));
  res.setHeader("RateLimit-Limit", limit);
  res.setHeader("RateLimit-Remaining", Math.max(0, remaining));
  res.setHeader("RateLimit-Reset", Math.ceil(resetMs / 1000));
}

function inMemoryRateLimit(
  windowMs: number,
  max: number,
  keyFn: (req: Request) => string
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req) || req.ip || "anonymous";
    const now = Date.now();
    let bucket = buckets.get(key);
    
    if (!bucket) {
      bucket = { tokens: max, last: now };
    }
    
    const elapsed = now - bucket.last;
    if (elapsed > windowMs) {
      bucket.tokens = max;
      bucket.last = now;
    }
    
    const resetMs = windowMs - elapsed;
    
    // Set rate limit headers
    setRateLimitHeaders(res, max, bucket.tokens - 1, resetMs);
    
    if (bucket.tokens <= 0) {
      res.setHeader("Retry-After", Math.ceil(resetMs / 1000));
      res.status(429).json({ 
        error: "rate_limited", 
        message: "Too many requests, please try again later",
        retryInMs: Math.max(resetMs, 0) 
      });
      return;
    }
    
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}

function redisRateLimit(
  windowMs: number,
  max: number,
  keyFn: (req: Request) => string
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = keyFn(req) || req.ip || "anonymous";
    const key = `${RATE_LIMIT_KEY_PREFIX}${identity}`;
    const ttlSeconds = Math.ceil(windowMs / 1000);
    
    const { acquired, remaining } = await tryAcquireLimit(key, max, ttlSeconds);
    
    // Set rate limit headers
    setRateLimitHeaders(res, max, remaining, windowMs);
    
    if (!acquired) {
      res.setHeader("Retry-After", ttlSeconds);
      res.status(429).json({ 
        error: "rate_limited", 
        message: "Too many requests, please try again later",
        retryInMs: windowMs 
      });
      return;
    }
    next();
  };
}

export function rateLimit(options: RateLimitOptions) {
  const windowMs = options.windowMs;
  const max = options.max;
  const keyFn =
    options.keyFn ||
    ((req: Request) => {
      const h = req.headers["x-admin-key"];
      const key = typeof h === "string" ? h : Array.isArray(h) ? h[0] : "";
      return key || req.ip || "";
    });

  if (options.useRedis) {
    return redisRateLimit(windowMs, max, keyFn);
  }
  return inMemoryRateLimit(windowMs, max, keyFn);
}
