/**
 * Register a DID with a tenant in Redis so the runtime accepts calls to that number.
 *
 * Usage:
 *   npx tsx scripts/register-tenant.ts
 *   npx tsx scripts/register-tenant.ts --did +12082149679 --tenant dev
 *
 * Uses .env for WHISPER_URL, TTS (COQUI_XTTS_URL / KOKORO_URL), etc.
 * Default DID: REGISTER_DID env or +12082149679. Default tenant: dev.
 */

import { createRedisClient } from '../src/redis/client';
import { env } from '../src/env';
import { buildTenantConfigKey } from '../src/tenants/tenantConfig';
import type { RuntimeTenantConfig } from '../src/tenants/tenantConfig';

const DEFAULT_DID = '+12082149679';
const DEFAULT_TENANT_ID = 'dev';

function parseArgs(argv: string[]): { did: string; tenantId: string } {
  let did = process.env.REGISTER_DID ?? DEFAULT_DID;
  let tenantId = DEFAULT_TENANT_ID;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--did' && argv[i + 1]) {
      did = argv[++i].trim();
    } else if ((argv[i] === '--tenant' && argv[i + 1]) || (argv[i].startsWith('--tenant='))) {
      if (argv[i].startsWith('--tenant=')) {
        tenantId = argv[i].slice('--tenant='.length).trim();
      } else {
        tenantId = argv[++i].trim();
      }
    }
  }

  return { did, tenantId };
}

function buildConfig(tenantId: string, did: string): RuntimeTenantConfig {
  const tts =
    env.TTS_MODE === 'coqui_xtts'
      ? {
          mode: 'coqui_xtts' as const,
          coquiXttsUrl: env.COQUI_XTTS_URL!,
          voice: env.COQUI_VOICE_ID ?? 'en_sample',
          language: 'en',
          format: 'wav' as const,
          sampleRate: env.TTS_SAMPLE_RATE,
          coquiTemperature: env.COQUI_TEMPERATURE,
          coquiLengthPenalty: env.COQUI_LENGTH_PENALTY,
          coquiRepetitionPenalty: env.COQUI_REPETITION_PENALTY,
          coquiTopK: env.COQUI_TOP_K,
          coquiTopP: env.COQUI_TOP_P,
          coquiSpeed: env.COQUI_SPEED,
          coquiSplitSentences: env.COQUI_SPLIT_SENTENCES,
        }
      : {
          mode: 'kokoro_http' as const,
          kokoroUrl: env.KOKORO_URL!,
          voice: env.KOKORO_VOICE_ID ?? 'af_bella',
          format: 'wav' as const,
          sampleRate: env.TTS_SAMPLE_RATE,
        };

  return {
    contractVersion: 'v1',
    tenantId,
    dids: [did],
    webhookSecret: process.env.TELNYX_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    caps: {
      maxConcurrentCallsTenant: env.TENANT_CONCURRENCY_CAP_DEFAULT,
      maxCallsPerMinuteTenant: env.TENANT_CALLS_PER_MIN_CAP_DEFAULT,
      maxConcurrentCallsGlobal: env.GLOBAL_CONCURRENCY_CAP,
    },
    stt: {
      mode: 'whisper_http',
      whisperUrl: env.WHISPER_URL,
      chunkMs: env.STT_CHUNK_MS,
      language: 'en',
    },
    tts,
    audio: {
      publicBaseUrl: env.AUDIO_PUBLIC_BASE_URL || undefined,
      storageDir: env.AUDIO_STORAGE_DIR || undefined,
      runtimeManaged: true,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args.tenantId, args.did);

  const redis = createRedisClient();
  const mapKey = `${env.TENANTMAP_PREFIX}:did:${args.did}`;
  const cfgKey = buildTenantConfigKey(args.tenantId);

  try {
    await redis.set(mapKey, args.tenantId);
    await redis.set(cfgKey, JSON.stringify(config, null, 2));
    process.stdout.write(`Registered DID ${args.did} -> tenant "${args.tenantId}"\n`);
    process.stdout.write(`  ${mapKey} = ${args.tenantId}\n`);
    process.stdout.write(`  ${cfgKey} = <config>\n`);
  } finally {
    redis.quit();
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
