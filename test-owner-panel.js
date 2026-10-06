#!/usr/bin/env node
/**
 * Full-pipeline call simulator: Whisper (STT) → Brain (LLM) with real tenant context.
 *
 * Sends saved recordings through the same path the runtime uses, including
 * transfer profiles, assistant context, and conversation history.
 *
 * Usage:
 *   node test-owner-panel.js                    # run all recordings
 *   node test-owner-panel.js --multi            # multi-turn conversation simulation
 *   node test-owner-panel.js --file <name>      # single recording
 */

const WHISPER_URL = process.env.WHISPER_URL || 'http://whisper:9000/transcribe_file';
const BRAIN_URL = process.env.BRAIN_URL || 'http://brain:3001/reply';
const CONTROL_URL = process.env.CONTROL_URL || 'http://control:4000';
const TENANT_ID = 'King-Sod';

// ─── Tenant context (matches real Redis config) ───
const TRANSFER_PROFILES = [
  {
    id: 'owner',
    name: 'Owner - handles pricing, estimates, and scheduling',
    holder: 'Nick',
    responsibilities: ['Owner - handles pricing', 'estimates', 'and scheduling'],
    destination: '+12086251175',
  },
  {
    id: 'id_1770875145053',
    name: 'Manager',
    holder: 'Morgan',
    responsibilities: ['Manager'],
    destination: '+12089164911',
  },
];

const ASSISTANT_CONTEXT = {
  'Business Hours': 'Mon-Fri 7am-5pm, Sat 8am-12pm, Sun Closed',
  'Address / Location': '1234 Turf Lane, Boise ID 83702',
  'Additional Info & FAQ':
    'We specialize in sod installation and lawn care. Free estimates available. Emergency irrigation repair available. Licensed and insured since 2010.',
  'Pricing & Services': [
    '- Sod Installation: $2.50/sqft (Full sod laying including seams and rolling)',
    '- Premium Bermuda Grass: $0.85/sqft (Farm-fresh bermuda sod pallets)',
    '- Soil Preparation: $1.25/sqft (Grading, tilling, and soil amendment)',
    '- Sprinkler Repair: $125/zone (Diagnose and repair per irrigation zone)',
    '- Lawn Consultation: $75/visit (On-site assessment and recommendations)',
    'Note: Prices may vary based on site conditions and accessibility. Minimum order 200 sqft for sod installation.',
  ].join('\n'),
};

// ─── Helpers ───

async function transcribe(audioPath) {
  const fs = require('fs');
  const path = require('path');
  const data = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath) || '.webm';

  const form = new FormData();
  form.append('file', new Blob([data]), `audio${ext}`);

  const start = Date.now();
  const resp = await fetch(WHISPER_URL, { method: 'POST', body: form });
  const json = await resp.json();
  return { transcript: json.text || '', sttMs: Date.now() - start };
}

async function brainReply(transcript, history) {
  const start = Date.now();
  const resp = await fetch(BRAIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: TENANT_ID,
      callControlId: 'test-sim-001',
      transcript,
      history,
      transferProfiles: TRANSFER_PROFILES,
      assistantContext: ASSISTANT_CONTEXT,
    }),
  });
  const json = await resp.json();
  return {
    reply: json.text || '',
    transfer: json.transfer || null,
    hangup: json.hangup || false,
    llmMs: Date.now() - start,
  };
}

// ─── Test scenarios ───

/**
 * Multi-turn conversation simulation:
 * Sends recordings sequentially, building up conversation history,
 * just like a real call would.
 */
async function multiTurnTest(recordings) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              MULTI-TURN CONVERSATION SIMULATION             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const history = [];
  let turnNumber = 0;

  // Simulate the greeting
  history.push({ role: 'assistant', content: 'King-Sod, How can I help you?' });
  console.log(`  🤖 [greeting] "King-Sod, How can I help you?"\n`);

  for (const rec of recordings) {
    turnNumber++;
    const sep = '─'.repeat(60);
    console.log(sep);
    console.log(`  Turn ${turnNumber}: ${rec.filename}`);
    console.log(sep);

    // STT
    const { transcript, sttMs } = await transcribe(rec.path);
    if (!transcript) {
      console.log(`  ⚠  Empty transcript (${sttMs}ms)\n`);
      continue;
    }
    console.log(`  👤 Caller: "${transcript}" (STT: ${sttMs}ms)`);

    // Add caller turn to history
    history.push({ role: 'user', content: transcript });

    // Brain reply
    const { reply, transfer, hangup, llmMs } = await brainReply(transcript, history);
    console.log(`  🤖 Brain:  "${reply}" (LLM: ${llmMs}ms)`);
    if (transfer) console.log(`  📞 Transfer: ${JSON.stringify(transfer)}`);
    if (hangup) console.log(`  ☎️  Hangup`);

    // Add assistant turn to history
    history.push({ role: 'assistant', content: reply });

    // ── Issue checks ──
    const issues = [];
    if (/anything else|is there anything/i.test(reply) && turnNumber <= 3) {
      issues.push('PREMATURE "anything else?" — should still be qualifying');
    }
    if (transfer && turnNumber <= 2) {
      issues.push('PREMATURE TRANSFER — should qualify before transferring');
    }
    if (/[\u4e00-\u9fff]/.test(reply)) {
      issues.push('CHINESE CHARACTERS in reply');
    }
    if (reply.split('?').length > 2) {
      issues.push('MULTIPLE QUESTIONS in one reply');
    }

    if (issues.length > 0) {
      console.log(`  ❌ ISSUES:`);
      issues.forEach((i) => console.log(`     • ${i}`));
    } else {
      console.log(`  ✅ No issues detected`);
    }
    console.log('');
  }

  console.log('═'.repeat(60));
  console.log('Conversation complete. Total turns:', turnNumber);
  console.log('═'.repeat(60));
}

/**
 * Single-shot test: each recording tested independently (no history).
 */
async function singleShotTests(recordings) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║               SINGLE-SHOT TESTS (with tenant context)       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const rec of recordings) {
    console.log(`── ${rec.filename} ──`);

    const { transcript, sttMs } = await transcribe(rec.path);
    if (!transcript) {
      console.log(`  ⚠  Empty transcript (${sttMs}ms)\n`);
      continue;
    }
    console.log(`  👤 "${transcript}" (STT: ${sttMs}ms)`);

    // Simulate: greeting already happened, this is the first caller utterance
    const history = [
      { role: 'assistant', content: 'King-Sod, How can I help you?' },
      { role: 'user', content: transcript },
    ];

    const { reply, transfer, hangup, llmMs } = await brainReply(transcript, history);
    console.log(`  🤖 "${reply}" (LLM: ${llmMs}ms)`);
    if (transfer) console.log(`  📞 Transfer: ${JSON.stringify(transfer)}`);
    if (hangup) console.log(`  ☎️  Hangup`);

    // Issue checks
    const issues = [];
    if (/anything else|is there anything/i.test(reply)) {
      issues.push('PREMATURE "anything else?" — first response should qualify');
    }
    if (transfer) {
      issues.push('IMMEDIATE TRANSFER — should qualify before transferring');
    }
    if (/[\u4e00-\u9fff]/.test(reply)) {
      issues.push('CHINESE CHARACTERS');
    }

    if (issues.length > 0) {
      console.log(`  ❌ ${issues.join(' | ')}`);
    } else {
      console.log(`  ✅ OK`);
    }
    console.log('');
  }
}

// ─── Main ───

async function main() {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);

  // Get recordings from the control plane's test-recordings volume
  let recDir;
  const dockerMountDir = '/recordings';
  const volumeDir = '/var/lib/docker/volumes/veralux-test-recordings/_data';
  const localDir = path.join(__dirname, 'control-plane/public/test-recordings');
  if (fs.existsSync(dockerMountDir) && fs.readdirSync(dockerMountDir).length > 0) {
    recDir = dockerMountDir;
  } else if (fs.existsSync(volumeDir)) {
    recDir = volumeDir;
  } else if (fs.existsSync(localDir)) {
    recDir = localDir;
  } else {
    // Try fetching from API
    console.log('Fetching recordings list from control plane...');
    const resp = await fetch(`${CONTROL_URL}/api/test-recordings`);
    const data = await resp.json();
    if (!data.recordings?.length) {
      console.error('No recordings found.');
      process.exit(1);
    }
    // Download them to a temp dir
    const tmpDir = '/tmp/test-recordings';
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const r of data.recordings) {
      // We can't download via API — recordings are stored in the container
      console.log(`  Found: ${r.filename} (${r.label})`);
    }
    console.error('\nCannot access recordings directly. Run inside Docker or mount the volume.');
    process.exit(1);
  }

  let recordings = fs
    .readdirSync(recDir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((filename) => ({
      filename,
      path: path.join(recDir, filename),
      label: filename.replace(/\.\w+$/, ''),
    }));

  // Filter by --file if specified
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const target = args[fileIdx + 1];
    recordings = recordings.filter((r) => r.filename.includes(target));
  }

  if (recordings.length === 0) {
    console.error('No recordings found in', recDir);
    process.exit(1);
  }

  console.log(`Found ${recordings.length} recording(s) in ${recDir}`);

  if (args.includes('--multi')) {
    await multiTurnTest(recordings);
  } else {
    await singleShotTests(recordings);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
