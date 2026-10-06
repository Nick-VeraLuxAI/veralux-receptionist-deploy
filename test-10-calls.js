#!/usr/bin/env node
/**
 * 10-Call Acceptance Test
 *
 * Simulates 10 consecutive structured calls through the full pipeline:
 *   STT (Whisper) -> Brain (LLM) -> Control Plane (call lifecycle + workflows)
 *
 * Tests: simple questions, pricing, quote requests, transfers, off-topic, hangup.
 */

const WHISPER_URL = process.env.WHISPER_URL || 'http://whisper:9000/transcribe_file';
const BRAIN_URL = process.env.BRAIN_URL || 'http://brain:3001/reply';
const CP_URL = process.env.CONTROL_URL || 'http://control:4000';
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const TENANT_ID = 'King-Sod';

const TRANSFER_PROFILES = [
  { id: 'owner', name: 'Owner', holder: 'Nick', responsibilities: ['pricing', 'estimates', 'scheduling'], destination: '+12086251175' },
  { id: 'mgr', name: 'Manager', holder: 'Morgan', responsibilities: ['Manager'], destination: '+12089164911' },
];

const ASSISTANT_CONTEXT = {
  'Business Hours': 'Mon-Fri 7am-5pm, Sat 8am-12pm, Sun Closed',
  'Address / Location': '1234 Turf Lane, Boise ID 83702',
  'Pricing & Services': '- Sod Installation: $2.50/sqft\n- Premium Bermuda Grass: $0.85/sqft\n- Soil Preparation: $1.25/sqft\n- Sprinkler Repair: $125/zone\n- Lawn Consultation: $75/visit',
};

// Test scenarios - mix of recordings and text-only
const SCENARIOS = [
  { id: 1, type: 'recording', file: null, fallbackText: 'What time do you guys close?', category: 'simple_question', expect: { noTransfer: true, noHangup: true } },
  { id: 2, type: 'recording', file: null, fallbackText: 'Do you have a list of products I can look at?', category: 'product_inquiry', expect: { noTransfer: true } },
  { id: 3, type: 'text', text: 'Hi, I want to get a quote for sod installation for my backyard', category: 'quote_request', expect: { noTransfer: true, shouldQualify: true } },
  { id: 4, type: 'recording', file: null, fallbackText: 'Do you sell sprinklers?', category: 'service_inquiry', expect: { noTransfer: true } },
  { id: 5, type: 'text', text: 'Can I speak to the manager please?', category: 'transfer_request', expect: { shouldTransfer: true } },
  { id: 6, type: 'recording', file: null, fallbackText: 'I like to eat bananas', category: 'off_topic', expect: { noTransfer: true } },
  { id: 7, type: 'text', text: 'How much does it cost to install sod in a 500 square foot area?', category: 'pricing_inquiry', expect: { noTransfer: true } },
  { id: 8, type: 'text', text: 'Where are you guys located?', category: 'location_question', expect: { noTransfer: true } },
  { id: 9, type: 'recording', file: null, fallbackText: 'When can I expect the quote to be done?', category: 'followup', expect: { noTransfer: true } },
  { id: 10, type: 'text', text: 'No that is all, thank you goodbye', category: 'hangup', expect: {} },
];

const fs = require('fs');
const path = require('path');

async function cpFetch(endpoint, body) {
  return fetch(`${CP_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify(body),
  });
}

async function transcribeFile(filePath) {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath) || '.webm';
  const form = new FormData();
  form.append('file', new Blob([data]), `audio${ext}`);
  const resp = await fetch(WHISPER_URL, { method: 'POST', body: form });
  const json = await resp.json();
  return json.text || '';
}

async function brainReply(transcript, history) {
  const resp = await fetch(BRAIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: TENANT_ID,
      callControlId: 'test-acceptance',
      transcript,
      history,
      transferProfiles: TRANSFER_PROFILES,
      assistantContext: ASSISTANT_CONTEXT,
    }),
  });
  return resp.json();
}

async function runTest() {
  // Find recordings
  const recDir = '/recordings';
  let recordings = [];
  if (fs.existsSync(recDir)) {
    recordings = fs.readdirSync(recDir).filter(f => !f.startsWith('.')).sort();
  }

  // Assign recordings to scenarios
  const recScenarios = SCENARIOS.filter(s => s.type === 'recording');
  for (let i = 0; i < recScenarios.length && i < recordings.length; i++) {
    recScenarios[i].file = path.join(recDir, recordings[i]);
  }

  console.log('='.repeat(70));
  console.log('  10-CALL ACCEPTANCE TEST');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Recordings:', recordings.length);
  console.log('='.repeat(70));
  console.log('');

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const scenario of SCENARIOS) {
    const callStart = Date.now();
    const issues = [];
    let transcript = '';
    let sttMs = 0;

    console.log(`--- Call ${scenario.id}: ${scenario.category} ---`);

    // Step 1: Get transcript (from recording or use text directly)
    if (scenario.type === 'recording' && scenario.file) {
      const sttStart = Date.now();
      transcript = await transcribeFile(scenario.file);
      sttMs = Date.now() - sttStart;
      if (!transcript) {
        transcript = scenario.fallbackText;
        issues.push('STT returned empty, using fallback text');
      }
      console.log(`  STT: "${transcript}" (${sttMs}ms)`);
    } else {
      transcript = scenario.text || scenario.fallbackText;
      console.log(`  Input: "${transcript}"`);
    }

    // Step 2: Start call in control plane
    const startResp = await cpFetch('/api/runtime/calls', {
      tenantId: TENANT_ID,
      action: 'start',
      callerId: `+1555000${String(scenario.id).padStart(4, '0')}`,
    });
    const startData = await startResp.json();
    const callId = startData.callId;
    if (!callId) {
      issues.push('Failed to create call');
      console.log(`  FAIL: Could not create call`);
      failed++;
      results.push({ id: scenario.id, category: scenario.category, status: 'FAIL', issues });
      continue;
    }

    // Step 3: Brain reply with greeting history
    const history = [
      { role: 'assistant', content: 'King-Sod, How can I help you?' },
      { role: 'user', content: transcript },
    ];

    const brainData = await brainReply(transcript, history);
    const reply = brainData.text || '';
    const transfer = brainData.transfer || null;
    const hangup = brainData.hangup || false;

    console.log(`  LLM: "${reply}"`);
    if (transfer) console.log(`  Transfer: ${JSON.stringify(transfer)}`);
    if (hangup) console.log(`  Hangup: true`);

    // Step 4: Update call in control plane
    await cpFetch('/api/runtime/calls', {
      tenantId: TENANT_ID,
      callId,
      action: 'update',
      callState: {
        stage: transfer ? 'handoff' : hangup ? 'closed' : 'qualifying',
        history: [...history, { role: 'assistant', content: reply }],
        lead: { phone: `+1555000${String(scenario.id).padStart(4, '0')}` },
      },
    });

    // Step 5: End call
    await cpFetch('/api/runtime/calls', {
      tenantId: TENANT_ID,
      callId,
      action: 'end',
      transcript: history.map(t => `${t.role}: ${t.content}`).join('\n') + `\nassistant: ${reply}`,
    });

    // Step 6: Validate expectations
    if (scenario.expect.noTransfer && transfer) {
      issues.push(`Unexpected transfer to ${transfer.to}`);
    }
    if (scenario.expect.shouldTransfer && !transfer) {
      issues.push('Expected transfer but none occurred');
    }
    if (scenario.expect.noHangup && hangup) {
      issues.push('Unexpected hangup');
    }
    if (scenario.expect.shouldQualify && /anything else|is there anything/i.test(reply)) {
      issues.push('Premature "anything else?" during qualifying');
    }
    if (/[\u4e00-\u9fff]/.test(reply)) {
      issues.push('Chinese characters in reply');
    }
    if (!reply || reply.length < 5) {
      issues.push('Empty or too-short reply');
    }

    const totalMs = Date.now() - callStart;
    const status = issues.length === 0 ? 'PASS' : 'FAIL';
    if (status === 'PASS') passed++;
    else failed++;

    console.log(`  Result: ${status} (${totalMs}ms)${issues.length ? ' -- ' + issues.join('; ') : ''}`);
    console.log('');

    results.push({ id: scenario.id, category: scenario.category, status, issues, transcript, reply, transfer, hangup, totalMs });
  }

  // Summary
  console.log('='.repeat(70));
  console.log('  RESULTS');
  console.log('='.repeat(70));
  console.log('');
  console.log(`  Total: ${SCENARIOS.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  Pass rate: ${Math.round(passed / SCENARIOS.length * 100)}%`);
  console.log('');

  for (const r of results) {
    const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] Call ${r.id} (${r.category})${r.issues.length ? ': ' + r.issues.join('; ') : ''}`);
  }

  // Check workflows fired
  console.log('\n  Waiting 10s for workflows to complete...');
  await new Promise(r => setTimeout(r, 10000));

  const wfResp = await fetch(`${CP_URL}/api/admin/workflows?tenantId=${TENANT_ID}`, {
    headers: { 'X-Admin-Key': ADMIN_KEY, 'X-Tenant-ID': TENANT_ID },
  });

  // Check workflow run count
  const runsResp = await fetch(`${CP_URL}/api/admin/workflow-runs?tenantId=${TENANT_ID}`, {
    headers: { 'X-Admin-Key': ADMIN_KEY, 'X-Tenant-ID': TENANT_ID },
  });

  if (runsResp.ok) {
    const runsData = await runsResp.json();
    const runs = runsData.runs || [];
    const completed = runs.filter(r => r.status === 'completed').length;
    const failedRuns = runs.filter(r => r.status === 'failed').length;
    console.log(`  Workflow runs: ${runs.length} total, ${completed} completed, ${failedRuns} failed`);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`  ${passed >= 9 ? 'ACCEPTANCE CRITERIA MET' : 'ACCEPTANCE CRITERIA NOT MET'} (${passed}/10 passed)`);
  console.log('='.repeat(70));

  process.exit(failed > 1 ? 1 : 0);
}

runTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
