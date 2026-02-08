import { env } from './env';
import { log } from './log';
import { buildServer } from './server';
import { getRedisClient } from './redis/client';

const { server, sessionManager } = buildServer();

// Graceful shutdown configuration
const SHUTDOWN_TIMEOUT_MS = 30_000; // Max time to wait for calls to drain
const SHUTDOWN_CHECK_INTERVAL_MS = 500;

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log.warn({ signal }, 'shutdown already in progress');
    return;
  }
  isShuttingDown = true;
  log.info({ signal }, 'graceful shutdown initiated');

  // Stop accepting new connections
  server.close(() => {
    log.info('http server closed');
  });

  // Wait for active calls to drain
  const startMs = Date.now();
  const drainCalls = (): Promise<void> => {
    return new Promise((resolve) => {
      const check = (): void => {
        const activeCount = sessionManager.getActiveSessionCount();
        const elapsed = Date.now() - startMs;

        if (activeCount === 0) {
          log.info({ elapsed_ms: elapsed }, 'all calls drained');
          resolve();
          return;
        }

        if (elapsed >= SHUTDOWN_TIMEOUT_MS) {
          log.warn({ active_calls: activeCount, elapsed_ms: elapsed }, 'shutdown timeout reached, forcing exit');
          resolve();
          return;
        }

        log.info({ active_calls: activeCount, elapsed_ms: elapsed }, 'waiting for calls to drain');
        setTimeout(check, SHUTDOWN_CHECK_INTERVAL_MS);
      };
      check();
    });
  };

  await drainCalls();

  // Close Redis connection
  try {
    const redis = getRedisClient();
    await redis.quit();
    log.info('redis connection closed');
  } catch (error) {
    log.warn({ err: error }, 'redis close error');
  }

  log.info('shutdown complete');
  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandled rejection');
});

server.listen(env.PORT, () => {
  log.info({ port: env.PORT }, 'server listening');
});