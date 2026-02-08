#!/usr/bin/env npx tsx
/**
 * Load testing script for Veralux Voice Runtime
 *
 * Simulates concurrent webhook calls to measure throughput and latency.
 *
 * Usage:
 *   npx tsx scripts/load-test.ts [options]
 *
 * Options:
 *   --url <url>           Runtime webhook URL (default: http://localhost:3000/webhooks/telnyx)
 *   --concurrency <n>     Number of concurrent requests (default: 10)
 *   --duration <seconds>  Test duration in seconds (default: 30)
 *   --rps <n>             Target requests per second (default: unlimited)
 *
 * Examples:
 *   npx tsx scripts/load-test.ts
 *   npx tsx scripts/load-test.ts --concurrency 50 --duration 60
 *   npx tsx scripts/load-test.ts --url https://prod.example.com/webhooks/telnyx --rps 100
 */

interface LoadTestOptions {
  url: string;
  concurrency: number;
  durationSeconds: number;
  targetRps?: number;
}

interface LoadTestResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  durationMs: number;
  rps: number;
  latency: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  errors: Map<string, number>;
}

function parseArgs(): LoadTestOptions {
  const args = process.argv.slice(2);
  const options: LoadTestOptions = {
    url: 'http://localhost:3000/webhooks/telnyx',
    concurrency: 10,
    durationSeconds: 30,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--url':
        options.url = nextArg;
        i++;
        break;
      case '--concurrency':
        options.concurrency = parseInt(nextArg, 10);
        i++;
        break;
      case '--duration':
        options.durationSeconds = parseInt(nextArg, 10);
        i++;
        break;
      case '--rps':
        options.targetRps = parseInt(nextArg, 10);
        i++;
        break;
      case '--help':
        console.log(`
Load testing script for Veralux Voice Runtime

Usage:
  npx tsx scripts/load-test.ts [options]

Options:
  --url <url>           Runtime webhook URL (default: http://localhost:3000/webhooks/telnyx)
  --concurrency <n>     Number of concurrent requests (default: 10)
  --duration <seconds>  Test duration in seconds (default: 30)
  --rps <n>             Target requests per second (default: unlimited)
`);
        process.exit(0);
    }
  }

  return options;
}

function generateCallControlId(): string {
  return `load-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function generateTelnyxPayload(eventType: string): object {
  const callControlId = generateCallControlId();
  const now = new Date().toISOString();

  const basePayload = {
    data: {
      event_type: eventType,
      id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      occurred_at: now,
      payload: {
        call_control_id: callControlId,
        call_leg_id: `leg_${Math.random().toString(36).slice(2, 12)}`,
        call_session_id: `sess_${Math.random().toString(36).slice(2, 12)}`,
        connection_id: 'conn_test',
        from: '+15551234567',
        to: '+15559876543',
        direction: 'incoming',
        state: eventType === 'call.initiated' ? 'initiated' : 'answered',
      },
      record_type: 'event',
    },
    meta: {
      attempt: 1,
      delivered_to: 'http://localhost:3000/webhooks/telnyx',
    },
  };

  return basePayload;
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

async function makeRequest(url: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const startMs = Date.now();
  const payload = generateTelnyxPayload('call.initiated');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'telnyx-timestamp': Math.floor(Date.now() / 1000).toString(),
        'telnyx-signature': 'load-test-skip-verification',
      },
      body: JSON.stringify(payload),
    });

    const latencyMs = Date.now() - startMs;

    if (response.ok || response.status === 401) {
      // 401 is expected if signature verification is enabled
      return { success: true, latencyMs };
    }

    return { success: false, latencyMs, error: `HTTP ${response.status}` };
  } catch (error) {
    const latencyMs = Date.now() - startMs;
    const errorMsg = error instanceof Error ? error.message : 'unknown';
    return { success: false, latencyMs, error: errorMsg };
  }
}

async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const latencies: number[] = [];
  const errors = new Map<string, number>();
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;

  const startMs = Date.now();
  const endMs = startMs + options.durationSeconds * 1000;

  console.log(`\nStarting load test...`);
  console.log(`  URL: ${options.url}`);
  console.log(`  Concurrency: ${options.concurrency}`);
  console.log(`  Duration: ${options.durationSeconds}s`);
  if (options.targetRps) {
    console.log(`  Target RPS: ${options.targetRps}`);
  }
  console.log('');

  const workers: Promise<void>[] = [];
  const delayBetweenRequests = options.targetRps
    ? (options.concurrency / options.targetRps) * 1000
    : 0;

  for (let i = 0; i < options.concurrency; i++) {
    workers.push(
      (async () => {
        while (Date.now() < endMs) {
          const result = await makeRequest(options.url);
          totalRequests++;
          latencies.push(result.latencyMs);

          if (result.success) {
            successfulRequests++;
          } else {
            failedRequests++;
            const errKey = result.error || 'unknown';
            errors.set(errKey, (errors.get(errKey) || 0) + 1);
          }

          if (delayBetweenRequests > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayBetweenRequests));
          }

          // Progress indicator every 100 requests
          if (totalRequests % 100 === 0) {
            const elapsed = Math.floor((Date.now() - startMs) / 1000);
            const currentRps = totalRequests / Math.max(elapsed, 1);
            process.stdout.write(`\r  Progress: ${totalRequests} requests, ${currentRps.toFixed(1)} rps`);
          }
        }
      })()
    );
  }

  await Promise.all(workers);

  const durationMs = Date.now() - startMs;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  console.log('\n');

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    durationMs,
    rps: totalRequests / (durationMs / 1000),
    latency: {
      min: sortedLatencies[0] || 0,
      max: sortedLatencies[sortedLatencies.length - 1] || 0,
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      p50: percentile(sortedLatencies, 50),
      p95: percentile(sortedLatencies, 95),
      p99: percentile(sortedLatencies, 99),
    },
    errors,
  };
}

function printResults(result: LoadTestResult): void {
  console.log('=== Load Test Results ===\n');

  console.log('Requests:');
  console.log(`  Total:      ${result.totalRequests}`);
  console.log(`  Successful: ${result.successfulRequests}`);
  console.log(`  Failed:     ${result.failedRequests}`);
  console.log(`  Error Rate: ${((result.failedRequests / result.totalRequests) * 100).toFixed(2)}%`);
  console.log('');

  console.log('Throughput:');
  console.log(`  Duration:   ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  RPS:        ${result.rps.toFixed(1)}`);
  console.log('');

  console.log('Latency (ms):');
  console.log(`  Min:        ${result.latency.min.toFixed(0)}`);
  console.log(`  Max:        ${result.latency.max.toFixed(0)}`);
  console.log(`  Avg:        ${result.latency.avg.toFixed(1)}`);
  console.log(`  p50:        ${result.latency.p50.toFixed(0)}`);
  console.log(`  p95:        ${result.latency.p95.toFixed(0)}`);
  console.log(`  p99:        ${result.latency.p99.toFixed(0)}`);

  if (result.errors.size > 0) {
    console.log('\nErrors:');
    for (const [error, count] of result.errors) {
      console.log(`  ${error}: ${count}`);
    }
  }

  console.log('\n=========================');
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    const result = await runLoadTest(options);
    printResults(result);

    // Exit with error if failure rate is too high
    const errorRate = result.failedRequests / result.totalRequests;
    if (errorRate > 0.1) {
      console.error('\nWARNING: Error rate exceeded 10%');
      process.exit(1);
    }
  } catch (error) {
    console.error('Load test failed:', error);
    process.exit(1);
  }
}

main();
