import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

describe('tenantConfig', () => {
  describe('resolveSecretRef', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test('resolves env: prefix from environment variable', async () => {
      process.env.TEST_SECRET = 'my-secret-value';
      const { resolveSecretRef } = await import('../src/tenants/tenantConfig');
      const result = resolveSecretRef('env:TEST_SECRET');
      assert.equal(result, 'my-secret-value');
    });

    test('returns null for missing env var', async () => {
      delete process.env.MISSING_VAR;
      const { resolveSecretRef } = await import('../src/tenants/tenantConfig');
      const result = resolveSecretRef('env:MISSING_VAR');
      assert.equal(result, null);
    });

    test('returns null for empty env var', async () => {
      process.env.EMPTY_VAR = '';
      const { resolveSecretRef } = await import('../src/tenants/tenantConfig');
      const result = resolveSecretRef('env:EMPTY_VAR');
      assert.equal(result, null);
    });

    test('returns literal string for non-env prefix', async () => {
      const { resolveSecretRef } = await import('../src/tenants/tenantConfig');
      const result = resolveSecretRef('literal-secret-value');
      assert.equal(result, 'literal-secret-value');
    });
  });

  describe('getWebhookSecret', () => {
    test('prefers webhookSecret over webhookSecretRef', async () => {
      const { getWebhookSecret } = await import('../src/tenants/tenantConfig');
      const config = {
        webhookSecret: 'direct-secret',
        webhookSecretRef: 'env:SOME_VAR',
      } as Parameters<typeof getWebhookSecret>[0];

      const result = getWebhookSecret(config);
      assert.equal(result, 'direct-secret');
    });

    test('falls back to webhookSecretRef when webhookSecret is missing', async () => {
      process.env.TENANT_WEBHOOK_SECRET = 'ref-secret';
      const { getWebhookSecret } = await import('../src/tenants/tenantConfig');
      const config = {
        webhookSecretRef: 'env:TENANT_WEBHOOK_SECRET',
      } as Parameters<typeof getWebhookSecret>[0];

      const result = getWebhookSecret(config);
      assert.equal(result, 'ref-secret');
    });

    test('returns null when neither is set', async () => {
      const { getWebhookSecret } = await import('../src/tenants/tenantConfig');
      const config = {} as Parameters<typeof getWebhookSecret>[0];
      const result = getWebhookSecret(config);
      assert.equal(result, null);
    });
  });

  describe('RuntimeTenantConfigSchema', () => {
    test('validates valid v1 config', async () => {
      const { RuntimeTenantConfigSchema } = await import('../src/tenants/tenantConfig');
      const config = {
        contractVersion: 'v1',
        tenantId: 'tenant-123',
        dids: ['+15551234567'],
        webhookSecret: 'secret',
        caps: {
          maxConcurrentCallsTenant: 10,
          maxCallsPerMinuteTenant: 60,
        },
        stt: {
          mode: 'whisper_http',
          chunkMs: 800,
        },
        tts: {
          mode: 'kokoro_http',
          kokoroUrl: 'http://localhost:8080',
        },
        audio: {},
      };

      const result = RuntimeTenantConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });

    test('rejects config without webhookSecret or webhookSecretRef', async () => {
      const { RuntimeTenantConfigSchema } = await import('../src/tenants/tenantConfig');
      const config = {
        contractVersion: 'v1',
        tenantId: 'tenant-123',
        dids: ['+15551234567'],
        caps: {
          maxConcurrentCallsTenant: 10,
          maxCallsPerMinuteTenant: 60,
        },
        stt: {
          mode: 'whisper_http',
          chunkMs: 800,
        },
        tts: {
          mode: 'kokoro_http',
          kokoroUrl: 'http://localhost:8080',
        },
        audio: {},
      };

      const result = RuntimeTenantConfigSchema.safeParse(config);
      assert.equal(result.success, false);
    });

    test('rejects invalid E.164 DID', async () => {
      const { RuntimeTenantConfigSchema } = await import('../src/tenants/tenantConfig');
      const config = {
        contractVersion: 'v1',
        tenantId: 'tenant-123',
        dids: ['not-a-valid-did'],
        webhookSecret: 'secret',
        caps: {
          maxConcurrentCallsTenant: 10,
          maxCallsPerMinuteTenant: 60,
        },
        stt: {
          mode: 'whisper_http',
          chunkMs: 800,
        },
        tts: {
          mode: 'kokoro_http',
          kokoroUrl: 'http://localhost:8080',
        },
        audio: {},
      };

      const result = RuntimeTenantConfigSchema.safeParse(config);
      assert.equal(result.success, false);
    });

    test('accepts webhookSecretRef instead of webhookSecret', async () => {
      const { RuntimeTenantConfigSchema } = await import('../src/tenants/tenantConfig');
      const config = {
        contractVersion: 'v1',
        tenantId: 'tenant-123',
        dids: ['+15551234567'],
        webhookSecretRef: 'env:MY_SECRET',
        caps: {
          maxConcurrentCallsTenant: 10,
          maxCallsPerMinuteTenant: 60,
        },
        stt: {
          mode: 'whisper_http',
          chunkMs: 800,
        },
        tts: {
          mode: 'kokoro_http',
          kokoroUrl: 'http://localhost:8080',
        },
        audio: {},
      };

      const result = RuntimeTenantConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });
  });
});
