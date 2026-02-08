#!/usr/bin/env npx tsx
/**
 * Concurrent Call Simulation Test for Veralux Voice Runtime
 *
 * Simulates real concurrent phone calls with:
 * - Webhook events (call.initiated, call.answered, call.hangup)
 * - WebSocket media streams with simulated audio frames
 * - Realistic call durations
 *
 * This measures true concurrent call capacity, not just webhook throughput.
 *
 * Usage:
 *   npx tsx scripts/concurrent-calls-test.ts [options]
 *
 * Options:
 *   --host <host>         Runtime host (default: localhost)
 *   --port <port>         Runtime port (default: 3000)
 *   --calls <n>           Number of concurrent calls to simulate (default: 10)
 *   --duration <seconds>  Call duration in seconds (default: 30)
 *   --ramp <seconds>      Ramp-up time to reach target concurrency (default: 5)
 *   --token <token>       Media stream token (default: from MEDIA_STREAM_TOKEN env)
 *
 * Examples:
 *   npx tsx scripts/concurrent-calls-test.ts --calls 20 --duration 60
 *   npx tsx scripts/concurrent-calls-test.ts --calls 50 --duration 120 --ramp 10
 */

import WebSocket from 'ws';

interface ConcurrentCallOptions {
  host: string;
  port: number;
  targetCalls: number;
  callDurationSeconds: number;
  rampUpSeconds: number;
  mediaToken: string;
}

interface CallSession {
  callControlId: string;
  startedAt: number;
  answeredAt?: number;
  mediaConnectedAt?: number;
  endedAt?: number;
  framesSent: number;
  framesReceived: number;
  ws?: WebSocket;
  state: 'initiated' | 'answered' | 'media_connected' | 'ended' | 'failed';
  error?: string;
}

interface TestResults {
  totalCallsAttempted: number;
  callsSuccessfullyCompleted: number;
  callsFailed: number;
  peakConcurrentCalls: number;
  avgConcurrentCalls: number;
  avgCallSetupTimeMs: number;
  avgMediaConnectTimeMs: number;
  totalFramesSent: number;
  totalFramesReceived: number;
  testDurationMs: number;
  errors: Map<string, number>;
}

function parseArgs(): ConcurrentCallOptions {
  const args = process.argv.slice(2);
  const options: ConcurrentCallOptions = {
    host: 'localhost',
    port: 3000,
    targetCalls: 10,
    callDurationSeconds: 30,
    rampUpSeconds: 5,
    mediaToken: process.env.MEDIA_STREAM_TOKEN || 'test-token',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--host':
        options.host = nextArg;
        i++;
        break;
      case '--port':
        options.port = parseInt(nextArg, 10);
        i++;
        break;
      case '--calls':
        options.targetCalls = parseInt(nextArg, 10);
        i++;
        break;
      case '--duration':
        options.callDurationSeconds = parseInt(nextArg, 10);
        i++;
        break;
      case '--ramp':
        options.rampUpSeconds = parseInt(nextArg, 10);
        i++;
        break;
      case '--token':
        options.mediaToken = nextArg;
        i++;
        break;
      case '--help':
        console.log(`
Concurrent Call Simulation Test for Veralux Voice Runtime

Simulates real concurrent phone calls with webhook events and WebSocket media streams.

Usage:
  npx tsx scripts/concurrent-calls-test.ts [options]

Options:
  --host <host>         Runtime host (default: localhost)
  --port <port>         Runtime port (default: 3000)
  --calls <n>           Number of concurrent calls to simulate (default: 10)
  --duration <seconds>  Call duration in seconds (default: 30)
  --ramp <seconds>      Ramp-up time to reach target concurrency (default: 5)
  --token <token>       Media stream token (default: from MEDIA_STREAM_TOKEN env)

Examples:
  npx tsx scripts/concurrent-calls-test.ts --calls 20 --duration 60
  npx tsx scripts/concurrent-calls-test.ts --calls 50 --duration 120 --ramp 10
`);
        process.exit(0);
    }
  }

  return options;
}

function generateCallControlId(): string {
  return `sim-call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTelnyxPayload(
  eventType: string,
  callControlId: string,
  extra?: Record<string, unknown>
): object {
  const now = new Date().toISOString();
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
        from: '+15551234567',
        to: '+15559876543',
        direction: 'incoming',
        state: eventType === 'call.initiated' ? 'initiated' : 'answered',
        ...extra,
      },
      record_type: 'event',
    },
  };
}

function createMediaStartMessage(streamId: string): object {
  return {
    event: 'start',
    start: {
      stream_id: streamId,
      media_format: {
        encoding: 'audio/x-mulaw',
        sample_rate: 8000,
        channels: 1,
      },
    },
  };
}

function createMediaMessage(streamId: string, sequenceNumber: number): object {
  // Generate 160 bytes of simulated μ-law audio (20ms at 8kHz)
  const audioData = Buffer.alloc(160);
  for (let i = 0; i < 160; i++) {
    // Generate simple sine wave pattern encoded as μ-law silence (0xFF)
    audioData[i] = 0xff;
  }

  return {
    event: 'media',
    stream_id: streamId,
    sequence_number: sequenceNumber,
    media: {
      track: 'inbound_track',
      payload: audioData.toString('base64'),
    },
  };
}

async function sendWebhook(
  baseUrl: string,
  payload: object
): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(`${baseUrl}/v1/telnyx/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'telnyx-timestamp': Math.floor(Date.now() / 1000).toString(),
        'telnyx-signature': 'test-skip',
      },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function simulateCall(
  options: ConcurrentCallOptions,
  session: CallSession,
  callDurationMs: number
): Promise<void> {
  const baseUrl = `http://${options.host}:${options.port}`;
  const wsUrl = `ws://${options.host}:${options.port}/v1/telnyx/media/${session.callControlId}?token=${encodeURIComponent(options.mediaToken)}`;

  try {
    // 1. Send call.initiated webhook
    const initiatedResult = await sendWebhook(
      baseUrl,
      createTelnyxPayload('call.initiated', session.callControlId)
    );
    if (!initiatedResult.ok) {
      session.state = 'failed';
      session.error = `call.initiated failed: ${initiatedResult.status}`;
      return;
    }

    // Small delay to simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

    // 2. Send call.answered webhook
    const answeredResult = await sendWebhook(
      baseUrl,
      createTelnyxPayload('call.answered', session.callControlId)
    );
    if (!answeredResult.ok) {
      session.state = 'failed';
      session.error = `call.answered failed: ${answeredResult.status}`;
      return;
    }
    session.answeredAt = Date.now();
    session.state = 'answered';

    // 3. Connect WebSocket for media
    const ws = new WebSocket(wsUrl);
    session.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        session.mediaConnectedAt = Date.now();
        session.state = 'media_connected';
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // 4. Send start message
    const streamId = `stream_${session.callControlId}`;
    ws.send(JSON.stringify(createMediaStartMessage(streamId)));

    // 5. Stream audio frames for call duration
    const frameIntervalMs = 20; // 20ms per frame (standard telephony)
    const totalFrames = Math.floor(callDurationMs / frameIntervalMs);
    let sequenceNumber = 0;

    // Handle incoming messages
    ws.on('message', () => {
      session.framesReceived++;
    });

    // Send frames at regular intervals
    for (let i = 0; i < totalFrames && ws.readyState === WebSocket.OPEN; i++) {
      ws.send(JSON.stringify(createMediaMessage(streamId, sequenceNumber++)));
      session.framesSent++;

      // Wait for next frame interval
      await new Promise((resolve) => setTimeout(resolve, frameIntervalMs));
    }

    // 6. Close WebSocket
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'stop' }));
      ws.close(1000, 'call_complete');
    }

    // 7. Send call.hangup webhook
    await sendWebhook(
      baseUrl,
      createTelnyxPayload('call.hangup', session.callControlId, {
        hangup_cause: 'normal_clearing',
        hangup_source: 'caller',
      })
    );

    session.endedAt = Date.now();
    session.state = 'ended';
  } catch (error) {
    session.state = 'failed';
    session.error = error instanceof Error ? error.message : 'unknown error';
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }
  }
}

async function runConcurrentCallTest(options: ConcurrentCallOptions): Promise<TestResults> {
  const sessions: CallSession[] = [];
  const errors = new Map<string, number>();
  const concurrencySnapshots: number[] = [];
  let peakConcurrent = 0;

  const testStartMs = Date.now();
  const rampDelayMs = (options.rampUpSeconds * 1000) / options.targetCalls;

  console.log('\n=== Concurrent Call Simulation ===\n');
  console.log(`Target: ${options.targetCalls} concurrent calls`);
  console.log(`Duration: ${options.callDurationSeconds}s per call`);
  console.log(`Ramp-up: ${options.rampUpSeconds}s`);
  console.log(`Host: ${options.host}:${options.port}`);
  console.log('');

  // Start calls with ramp-up
  const callPromises: Promise<void>[] = [];

  for (let i = 0; i < options.targetCalls; i++) {
    const session: CallSession = {
      callControlId: generateCallControlId(),
      startedAt: Date.now(),
      framesSent: 0,
      framesReceived: 0,
      state: 'initiated',
    };
    sessions.push(session);

    // Vary call duration slightly for realism (+/- 20%)
    const durationVariance = 0.8 + Math.random() * 0.4;
    const callDurationMs = options.callDurationSeconds * 1000 * durationVariance;

    callPromises.push(simulateCall(options, session, callDurationMs));

    // Progress update
    const activeCalls = sessions.filter(
      (s) => s.state === 'answered' || s.state === 'media_connected'
    ).length;
    if (activeCalls > peakConcurrent) peakConcurrent = activeCalls;
    concurrencySnapshots.push(activeCalls);

    process.stdout.write(
      `\r  Starting calls: ${i + 1}/${options.targetCalls}, Active: ${activeCalls}`
    );

    // Ramp-up delay between starting calls
    if (i < options.targetCalls - 1) {
      await new Promise((resolve) => setTimeout(resolve, rampDelayMs));
    }
  }

  console.log('\n  All calls started, waiting for completion...\n');

  // Monitor progress while calls are running
  const monitorInterval = setInterval(() => {
    const activeCalls = sessions.filter(
      (s) => s.state === 'answered' || s.state === 'media_connected'
    ).length;
    const completedCalls = sessions.filter((s) => s.state === 'ended').length;
    const failedCalls = sessions.filter((s) => s.state === 'failed').length;

    if (activeCalls > peakConcurrent) peakConcurrent = activeCalls;
    concurrencySnapshots.push(activeCalls);

    process.stdout.write(
      `\r  Active: ${activeCalls}, Completed: ${completedCalls}, Failed: ${failedCalls}`
    );
  }, 1000);

  // Wait for all calls to complete
  await Promise.all(callPromises);
  clearInterval(monitorInterval);

  const testEndMs = Date.now();

  // Gather results
  const completedSessions = sessions.filter((s) => s.state === 'ended');
  const failedSessions = sessions.filter((s) => s.state === 'failed');

  // Collect errors
  for (const session of failedSessions) {
    const errKey = session.error || 'unknown';
    errors.set(errKey, (errors.get(errKey) || 0) + 1);
  }

  // Calculate metrics
  const setupTimes = completedSessions
    .filter((s) => s.answeredAt)
    .map((s) => s.answeredAt! - s.startedAt);
  const mediaConnectTimes = completedSessions
    .filter((s) => s.mediaConnectedAt && s.answeredAt)
    .map((s) => s.mediaConnectedAt! - s.answeredAt!);

  const avgConcurrent =
    concurrencySnapshots.length > 0
      ? concurrencySnapshots.reduce((a, b) => a + b, 0) / concurrencySnapshots.length
      : 0;

  console.log('\n');

  return {
    totalCallsAttempted: sessions.length,
    callsSuccessfullyCompleted: completedSessions.length,
    callsFailed: failedSessions.length,
    peakConcurrentCalls: peakConcurrent,
    avgConcurrentCalls: avgConcurrent,
    avgCallSetupTimeMs: setupTimes.length > 0 ? setupTimes.reduce((a, b) => a + b, 0) / setupTimes.length : 0,
    avgMediaConnectTimeMs: mediaConnectTimes.length > 0 ? mediaConnectTimes.reduce((a, b) => a + b, 0) / mediaConnectTimes.length : 0,
    totalFramesSent: sessions.reduce((sum, s) => sum + s.framesSent, 0),
    totalFramesReceived: sessions.reduce((sum, s) => sum + s.framesReceived, 0),
    testDurationMs: testEndMs - testStartMs,
    errors,
  };
}

function printResults(results: TestResults): void {
  console.log('=== Concurrent Call Test Results ===\n');

  console.log('Calls:');
  console.log(`  Attempted:  ${results.totalCallsAttempted}`);
  console.log(`  Completed:  ${results.callsSuccessfullyCompleted}`);
  console.log(`  Failed:     ${results.callsFailed}`);
  console.log(
    `  Success:    ${((results.callsSuccessfullyCompleted / results.totalCallsAttempted) * 100).toFixed(1)}%`
  );
  console.log('');

  console.log('Concurrency:');
  console.log(`  Peak:       ${results.peakConcurrentCalls} concurrent calls`);
  console.log(`  Average:    ${results.avgConcurrentCalls.toFixed(1)} concurrent calls`);
  console.log('');

  console.log('Latency:');
  console.log(`  Call Setup: ${results.avgCallSetupTimeMs.toFixed(0)}ms avg`);
  console.log(`  Media Connect: ${results.avgMediaConnectTimeMs.toFixed(0)}ms avg`);
  console.log('');

  console.log('Media:');
  console.log(`  Frames Sent: ${results.totalFramesSent.toLocaleString()}`);
  console.log(`  Frames Received: ${results.totalFramesReceived.toLocaleString()}`);
  console.log('');

  console.log('Duration:');
  console.log(`  Total Test: ${(results.testDurationMs / 1000).toFixed(1)}s`);

  if (results.errors.size > 0) {
    console.log('\nErrors:');
    for (const [error, count] of results.errors) {
      console.log(`  ${error}: ${count}`);
    }
  }

  console.log('\n====================================');
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    const results = await runConcurrentCallTest(options);
    printResults(results);

    // Exit with error if too many calls failed
    const successRate = results.callsSuccessfullyCompleted / results.totalCallsAttempted;
    if (successRate < 0.9) {
      console.error('\nWARNING: Success rate below 90%');
      process.exit(1);
    }
  } catch (error) {
    console.error('Concurrent call test failed:', error);
    process.exit(1);
  }
}

main();
