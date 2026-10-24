/**
 * Live end-to-end smoke test against REAL TinyFish (docs.tinyfish.ai).
 *
 * Runs the prioritized product-search journey: a genuine browser session on
 * scrapeme.live/shop driven by the TinyFish Agent API over SSE, then normalizes
 * observations/evidence, then (if VERIFICATION_ENGINE_URL is set) forwards the
 * record to the verification engine for an independent verdict.
 *
 * Usage:
 *   TINYFISH_API_KEY=... node scripts/smoke-live.js [--scenario product-search]
 *
 * Exit codes:
 *   0  execution completed AND (verification passed, or verification not
 *      configured but execution evidence looks sane — clearly reported)
 *   1  failure (API error, execution failed/timed out, or verification FAIL)
 *   2  missing TINYFISH_API_KEY
 *
 * This script NEVER fabricates results: everything printed comes from the
 * actual TinyFish stream / run object / verification engine response.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { TinyFishClient } from '../src/tinyfish/client.js';
import { VerificationAdapter } from '../src/verification/adapter.js';
import { normalizeExecution } from '../src/execution/normalize.js';
import { getScenario, scenarioSummaries } from '../src/scenarios/index.js';

const args = process.argv.slice(2);
const scenarioArgIdx = args.indexOf('--scenario');
const scenarioId = scenarioArgIdx !== -1 ? args[scenarioArgIdx + 1] : 'product-search';

const config = loadConfig();
if (!config.tinyfish.configured) {
  console.error('[smoke] TINYFISH_API_KEY is not set. Get one at https://agent.tinyfish.ai/api-keys and put it in .env');
  process.exit(2);
}

const scenario = getScenario(scenarioId);
if (!scenario) {
  console.error(`[smoke] Unknown scenario "${scenarioId}". Available:`);
  for (const s of scenarioSummaries()) console.error(`  - ${s.id}`);
  process.exit(1);
}

console.log('[smoke] ═══ FlowFix AI live end-to-end smoke ═══');
console.log(`[smoke] scenario:   ${scenario.id} — ${scenario.name}`);
console.log(`[smoke] requirement: ${scenario.requirement}`);
console.log(`[smoke] target url: ${scenario.url}`);
console.log(`[smoke] tinyfish:   ${config.tinyfish.baseUrl}`);
console.log(`[smoke] verification engine: ${config.verification.configured ? config.verification.baseUrl : 'not configured (verdict will stay null)'}`);

const client = new TinyFishClient({ apiKey: config.tinyfish.apiKey, baseUrl: config.tinyfish.baseUrl });
const verifier = new VerificationAdapter({ baseUrl: config.verification.baseUrl, timeoutMs: config.verification.timeoutMs });

const events = [];
const t0 = Date.now();

let complete;
try {
  complete = await client.runSse(
    {
      url: scenario.url,
      goal: scenario.goal,
      browserProfile: scenario.browserProfile,
      agentConfig: scenario.agentConfig,
      captureConfig: scenario.captureConfig,
    },
    {
      onEvent: (event) => {
        events.push(event);
        const ms = String(Date.now() - t0).padStart(6);
        if (event.type === 'PROGRESS') console.log(`[smoke] +${ms}ms PROGRESS  ${event.purpose}`);
        else if (event.type === 'STARTED') console.log(`[smoke] +${ms}ms STARTED   run_id=${event.run_id}`);
        else if (event.type === 'STREAMING_URL') console.log(`[smoke] +${ms}ms STREAM    ${event.streaming_url}`);
        else if (event.type === 'COMPLETE') console.log(`[smoke] +${ms}ms COMPLETE  status=${event.status}`);
        else if (event.type === 'HEARTBEAT') { /* silent */ }
        else console.log(`[smoke] +${ms}ms ${event.type ?? 'UNKNOWN'}`);
      },
    },
  );
} catch (err) {
  console.error(`[smoke] TinyFish call failed: [${err?.code ?? 'NETWORK'}] ${err?.message ?? err}`);
  if (err?.upstream) console.error(`[smoke] upstream error: ${JSON.stringify(err.upstream)}`);
  process.exit(1);
}

// Fetch the run object for step screenshots (real evidence).
const runId = events.find((e) => e.run_id)?.run_id ?? null;
let runObject = null;
if (runId) {
  try {
    runObject = await client.getRun(runId);
    console.log(`[smoke] run object fetched: ${runObject.num_of_steps ?? '?'} steps, status=${runObject.status}`);
  } catch (err) {
    console.warn(`[smoke] could not fetch run object (evidence limited to SSE): ${err.message}`);
  }
}

const record = normalizeExecution({ events, runObject });
console.log('[smoke] ─── Normalized execution record ───');
console.log(`[smoke] execution status: ${record.execution_status}`);
console.log(`[smoke] observations:     ${record.observations.length}`);
for (const obs of record.observations) {
  if (obs.kind === 'agent_result') console.log(`[smoke]   result (${obs.result.format}): ${JSON.stringify(obs.result.value).slice(0, 300)}`);
}
const screenshots = record.evidence.filter((e) => e.kind === 'step_screenshot');
console.log(`[smoke] evidence items:   ${record.evidence.length} (${screenshots.length} screenshots, raw event log: ${record.evidence.find((e) => e.kind === 'raw_event_log')?.event_count ?? 0} events)`);

if (record.execution_status !== 'COMPLETED') {
  console.error(`[smoke] execution did NOT complete: ${record.execution_status}`);
  if (record.upstream_error) console.error(`[smoke] upstream error: ${JSON.stringify(record.upstream_error)}`);
  process.exit(1);
}

// Goal-level failure check (COMPLETED ≠ goal achieved — docs warning).
const resultObs = record.observations.find((o) => o.kind === 'agent_result');
if (resultObs?.result?.value?.status === 'failure') {
  console.error(`[smoke] browser executed but the GOAL failed: ${resultObs.result.value.reason}`);
  process.exit(1);
}

// Independent verification (only if Meenu's engine is configured).
if (verifier.isConfigured()) {
  console.log('[smoke] ─── Handing evidence to the verification engine ───');
  const outcome = await verifier.verify({
    executionId: `smoke-${Date.now()}`,
    scenarioId: scenario.id,
    requirement: scenario.requirement,
    url: scenario.url,
    goal: scenario.goal,
    expectedOutcome: scenario.expected_outcome,
    record,
  });
  console.log(`[smoke] verification status: ${outcome.status}`);
  console.log(`[smoke] verification verdict: ${outcome.verdict ?? '(null)'}`);
  if (outcome.details?.summary) console.log(`[smoke] engine summary: ${outcome.details.summary}`);
  for (const check of outcome.details?.checks ?? []) {
    console.log(`[smoke]   check ${check.id}: ${check.passed ? 'PASS' : 'FAIL'} — ${check.description}`);
  }
  if (outcome.verdict !== 'PASS') process.exit(1);
  console.log('[smoke] ✅ Real browser journey executed AND independently verified PASS');
} else {
  console.log('[smoke] verification engine not configured — execution evidence above is real, but NO verdict is claimed.');
  console.log('[smoke] ✅ Real browser journey executed (set VERIFICATION_ENGINE_URL to get independent verdicts)');
}

process.exit(0);
