// src/middleware/ipRateLimit.ts
import type { Request, Response, NextFunction } from "express";

type Options = {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
};

export function ipRateLimit(opts: Options) {
  const windowMs = opts.windowMs;
  const max = opts.max;

  // key -> { resetAt, count }
  const buckets = new Map<string, { resetAt: number; count: number }>();

  const keyFn =
    opts.keyFn ??
    ((req: Request) => {
      // Prefer X-Forwarded-For if behind a proxy/load balancer
      const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
      return xff || req.ip || "unknown";
    });

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFn(req);

    const cur = buckets.get(key);
    if (!cur || now > cur.resetAt) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      return next();
    }

    cur.count += 1;
    if (cur.count > max) {
      const retryAfterSec = Math.ceil((cur.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: "ip_rate_limited",
        message: "Too many requests from this IP. Try again shortly.",
        retryAfterSec,
      });
    }

    return next();
  };
}
