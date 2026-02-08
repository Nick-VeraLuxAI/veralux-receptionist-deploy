/**
 * Integration tests for call flow webhook handling
 *
 * These tests verify the complete webhook flow from call.initiated through call.hangup.
 * They require a running Redis instance (provided by CI or local docker-compose).
 *
 * Run with: npm test -- tests/callFlow.integration.test.ts
 */

import { describe, it, beforeAll, afterAll, before } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { setTestEnv } from './testEnv';

// Set test environment before importing server modules
setTestEnv();

import { buildServer } from '../src/server';
import { getRedisClient } from '../src/redis/client';
import type { RuntimeTenantConfig } from '../src/tenants/tenantConfig';

const TEST_TENANT_ID = 'test-tenant-integration';
const TEST_DID = '+15551234567';
const TEST_PORT = 3099;

interface TestContext {
  app: ReturnType<typeof buildServer>['app'];
  server: http.Server;
  sessionManager: ReturnType<typeof buildServer>['sessionManager'];
  baseUrl: string;
}

let ctx: TestContext;

function generateCallControlId(): string {
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createWebhookPayload(
  eventType: string,
  callControlId: string,
  tenantId?: string,
  extra?: Record<string, unknown>
): object {
  const now = new Date().toISOString();
  const clientState = tenantId
    ? Buffer.from(JSON.stringify({ tenant_id: tenantId })).toString('base64')
    : undefined;

  return {
    data: {
      event_type: eventType,
      id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      occurred_at: now,
      payload: {
        call_control_id: callControlId,
        call_leg_id: `leg_${Math.random().toString(36).slice(2, 12)}`,
        call_session_id: `sess_${Math.random().toString(36).slice(2, 12)}`,
        connection_id: 'conn_test',
        from: '+15559999999',
        to: TEST_DID,
        direction: 'incoming',
        state: eventType.includes('initiated') ? 'initiated' : 'answered',
        ...(clientState ? { client_state: clientState } : {}),
        ...extra,
      },
      record_type: 'event',
    },
  };
}

async function postWebhook(url: string, payload: object): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(url);

    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'telnyx-timestamp': Math.floor(Date.now() / 1000).toString(),
          'telnyx-signature': 'test-skip',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode || 0, body });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function setupTestTenant(): Promise<void> {
  const redis = getRedisClient();

  // Map DID to tenant
  await redis.set(`tenantmap:did:${TEST_DID}`, TEST_TENANT_ID);

  // Store tenant config
  const tenantConfig: RuntimeTenantConfig = {
    contractVersion: 'v1',
    tenantId: TEST_TENANT_ID,
    dids: [TEST_DID],
    webhookSecret: 'test-secret',
    caps: {
      concurrency: 5,
      callsPerMin: 10,
    },
    stt: {
      provider: 'whisper-http',
      endpoint: process.env.WHISPER_URL || 'http://localhost/whisper',
    },
    tts: {
      provider: 'kokoro',
      endpoint: process.env.KOKORO_URL || 'http://localhost/kokoro',
    },
    audio: {},
  };

  await redis.set(`tenantcfg:${TEST_TENANT_ID}`, JSON.stringify(tenantConfig));
}

async function cleanupTestTenant(): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`tenantmap:did:${TEST_DID}`);
  await redis.del(`tenantcfg:${TEST_TENANT_ID}`);
  // Clean up any capacity keys
  await redis.del(`cap:global:calls`);
  await redis.del(`cap:tenant:${TEST_TENANT_ID}:calls`);
  await redis.del(`cap:tenant:${TEST_TENANT_ID}:rpm`);
}

describe('Call Flow Integration Tests', { skip: !process.env.REDIS_URL }, () => {
  beforeAll(async () => {
    // Skip signature verification for tests
    process.env.TELNYX_SKIP_SIGNATURE = 'true';

    const built = buildServer();
    ctx = {
      ...built,
      baseUrl: `http://localhost:${TEST_PORT}`,
    };

    await new Promise<void>((resolve) => {
      ctx.server = built.server.listen(TEST_PORT, resolve);
    });

    await setupTestTenant();
  });

  afterAll(async () => {
    await cleanupTestTenant();

    if (ctx?.server) {
      await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    }

    try {
      const redis = getRedisClient();
      await redis.quit();
    } catch {
      // Ignore Redis close errors in cleanup
    }
  });

  it('should accept call.initiated webhook', async () => {
    const callControlId = generateCallControlId();
    const payload = createWebhookPayload('call.initiated', callControlId);

    const { status, body } = await postWebhook(`${ctx.baseUrl}/webhooks/telnyx`, payload);

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { ok: true });
  });

  it('should accept call.answered webhook', async () => {
    const callControlId = generateCallControlId();

    // First initiate
    await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.initiated', callControlId)
    );

    // Then answer with tenant in client_state
    const payload = createWebhookPayload('call.answered', callControlId, TEST_TENANT_ID);
    const { status, body } = await postWebhook(`${ctx.baseUrl}/webhooks/telnyx`, payload);

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { ok: true });
  });

  it('should handle full call lifecycle', async () => {
    const callControlId = generateCallControlId();

    // 1. call.initiated
    const initiated = await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.initiated', callControlId)
    );
    assert.strictEqual(initiated.status, 200, 'call.initiated should succeed');

    // 2. call.answered
    const answered = await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.answered', callControlId, TEST_TENANT_ID)
    );
    assert.strictEqual(answered.status, 200, 'call.answered should succeed');

    // 3. call.hangup
    const hangup = await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.hangup', callControlId, TEST_TENANT_ID, {
        hangup_cause: 'normal_clearing',
        hangup_source: 'caller',
      })
    );
    assert.strictEqual(hangup.status, 200, 'call.hangup should succeed');

    // Allow time for async cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('should handle playback events', async () => {
    const callControlId = generateCallControlId();

    // Setup call
    await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.initiated', callControlId)
    );
    await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.answered', callControlId, TEST_TENANT_ID)
    );

    // Playback started
    const started = await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.playback.started', callControlId, TEST_TENANT_ID)
    );
    assert.strictEqual(started.status, 200, 'call.playback.started should succeed');

    // Playback ended
    const ended = await postWebhook(
      `${ctx.baseUrl}/webhooks/telnyx`,
      createWebhookPayload('call.playback.ended', callControlId, TEST_TENANT_ID)
    );
    assert.strictEqual(ended.status, 200, 'call.playback.ended should succeed');
  });

  it('should return healthy status from /health', async () => {
    const response = await fetch(`${ctx.baseUrl}/health`);
    assert.strictEqual(response.status, 200);

    const body = (await response.json()) as { status: string; checks: { redis: { ok: boolean } } };
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.checks.redis.ok, true);
  });

  it('should return ready status from /health/ready', async () => {
    const response = await fetch(`${ctx.baseUrl}/health/ready`);
    assert.strictEqual(response.status, 200);

    const body = (await response.json()) as { status: string };
    assert.strictEqual(body.status, 'ok');
  });

  it('should return live status from /health/live', async () => {
    const response = await fetch(`${ctx.baseUrl}/health/live`);
    assert.strictEqual(response.status, 200);

    const body = (await response.json()) as { status: string };
    assert.strictEqual(body.status, 'ok');
  });
});
