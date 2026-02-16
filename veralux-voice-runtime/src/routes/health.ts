import { Router } from 'express';
import { getRedisClient } from '../redis/client';
import { env } from '../env';
import { log } from '../log';

export const healthRouter = Router();

interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  checks: {
    redis: { ok: boolean; latency_ms?: number; error?: string };
    whisper?: { ok: boolean; latency_ms?: number; error?: string };
    tts?: { ok: boolean; latency_ms?: number; error?: string };
  };
  uptime_seconds: number;
}

const startTime = Date.now();

async function checkRedis(): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  const start = Date.now();
  try {
    const redis = getRedisClient();
    await redis.ping();
    return { ok: true, latency_ms: Date.now() - start };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown', latency_ms: Date.now() - start };
  }
}

async function checkUrl(url: string, timeout = 5000): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return { ok: response.ok, latency_ms: Date.now() - start };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown', latency_ms: Date.now() - start };
  }
}

// Basic liveness probe (always returns 200 if process is running)
healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness probe (checks dependencies)
healthRouter.get('/ready', async (_req, res) => {
  const redis = await checkRedis();
  const ready = redis.ok;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    checks: { redis },
  });
});

// Full health check with all dependencies
healthRouter.get('/', async (_req, res) => {
  const [redis, whisper, tts] = await Promise.all([
    checkRedis(),
    env.WHISPER_URL ? checkUrl(env.WHISPER_URL.replace('/transcribe', '/health').replace('/v1/audio/transcriptions', '/health')) : Promise.resolve(undefined),
    env.TTS_MODE === 'coqui_xtts' && env.COQUI_XTTS_URL
      ? checkUrl(env.COQUI_XTTS_URL.replace('/tts', '/health'))
      : env.KOKORO_URL
        ? checkUrl(env.KOKORO_URL.replace('/v1/kokoro', '/health'))
        : Promise.resolve(undefined),
  ]);

  const checks: HealthStatus['checks'] = { redis };
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;

  const allOk = redis.ok && (whisper?.ok ?? true) && (tts?.ok ?? true);
  const anyFailed = !redis.ok;

  const status: HealthStatus = {
    status: anyFailed ? 'unhealthy' : allOk ? 'ok' : 'degraded',
    checks,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  };

  if (!allOk) {
    log.warn({ event: 'health_check_degraded', checks }, 'health check not fully ok');
  }

  res.status(anyFailed ? 503 : 200).json(status);
});