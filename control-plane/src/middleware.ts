/**
 * Production-ready Express middleware utilities
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { randomUUID } from "crypto";

// ────────────────────────────────────────────────
// Request ID / Correlation ID Middleware
// ────────────────────────────────────────────────

export interface RequestWithId extends Request {
  requestId: string;
}

/**
 * Adds a unique request ID to each request for tracing.
 * Uses X-Request-ID header if provided, otherwise generates a new UUID.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const existingId = req.headers["x-request-id"];
  const requestId = typeof existingId === "string" ? existingId : randomUUID();
  (req as RequestWithId).requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}

/**
 * Get the request ID from a request object
 */
export function getRequestId(req: Request): string {
  return (req as RequestWithId).requestId || "unknown";
}

// ────────────────────────────────────────────────
// Structured Logger
// ────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

function formatLog(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const logObj = {
    timestamp,
    level,
    message,
    ...context,
  };
  return JSON.stringify(logObj);
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    if (shouldLog("debug")) {
      console.log(formatLog("debug", message, context));
    }
  },
  info(message: string, context?: LogContext): void {
    if (shouldLog("info")) {
      console.log(formatLog("info", message, context));
    }
  },
  warn(message: string, context?: LogContext): void {
    if (shouldLog("warn")) {
      console.warn(formatLog("warn", message, context));
    }
  },
  error(message: string, context?: LogContext): void {
    if (shouldLog("error")) {
      console.error(formatLog("error", message, context));
    }
  },
};

// ────────────────────────────────────────────────
// Async Handler Wrapper
// ────────────────────────────────────────────────

/**
 * Wraps an async route handler to catch errors and pass them to Express error handling.
 * This prevents unhandled promise rejections from crashing the server.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ────────────────────────────────────────────────
// Request Timeout Middleware
// ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);

/**
 * Adds a timeout to requests. If the request takes longer than the timeout,
 * a 503 Service Unavailable response is sent.
 */
export function requestTimeout(timeoutMs: number = DEFAULT_TIMEOUT_MS): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn("Request timeout", {
          requestId: getRequestId(req),
          path: req.path,
          method: req.method,
          timeoutMs,
        });
        res.status(503).json({
          error: "request_timeout",
          message: "Request took too long to process",
        });
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    res.on("finish", () => clearTimeout(timeout));
    res.on("close", () => clearTimeout(timeout));

    next();
  };
}

// ────────────────────────────────────────────────
// Global Error Handler
// ────────────────────────────────────────────────

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown;
}

/**
 * Creates a standardized API error
 */
export function createApiError(
  message: string,
  statusCode: number = 500,
  code?: string,
  details?: unknown
): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Global error handler middleware. Must be registered last.
 * Logs errors and returns standardized error responses.
 */
export function globalErrorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = getRequestId(req);
  const statusCode = err.statusCode || 500;
  const errorCode = err.code || "internal_error";

  // Log the error
  logger.error("Request error", {
    requestId,
    path: req.path,
    method: req.method,
    statusCode,
    errorCode,
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });

  // Don't expose internal error details in production
  const isProduction = process.env.NODE_ENV === "production";
  const message = statusCode >= 500 && isProduction
    ? "An internal error occurred"
    : err.message;

  if (!res.headersSent) {
    res.status(statusCode).json({
      error: errorCode,
      message,
      requestId,
      ...(err.details && !isProduction ? { details: err.details } : {}),
    });
  }
}

// ────────────────────────────────────────────────
// Request Logging Middleware
// ────────────────────────────────────────────────

/**
 * Logs incoming requests and their responses
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const requestId = getRequestId(req);

  // Log request
  logger.info("Incoming request", {
    requestId,
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    userAgent: req.headers["user-agent"],
    ip: req.ip,
  });

  // Log response when finished
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    const level: LogLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    
    logger[level]("Request completed", {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}

// ────────────────────────────────────────────────
// Input Validation Helpers
// ────────────────────────────────────────────────

import { z, ZodSchema, ZodError } from "zod";

/**
 * Validates request body against a Zod schema.
 * Returns the parsed data or throws an ApiError.
 */
export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw createApiError(
        "Validation failed",
        400,
        "validation_error",
        err.errors.map((e) => ({ path: e.path.join("."), message: e.message }))
      );
    }
    throw err;
  }
}

/**
 * Creates middleware that validates the request body against a Zod schema
 */
export function validateBodyMiddleware<T>(schema: ZodSchema<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = validateBody(schema, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ────────────────────────────────────────────────
// Common Validation Schemas
// ────────────────────────────────────────────────

export const commonSchemas = {
  uuid: z.string().uuid(),
  
  tenantId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "Invalid tenant ID format"),
  
  phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format"),
  
  url: z.string().url(),
  
  email: z.string().email(),
  
  pagination: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
  }),
};
