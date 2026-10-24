/**
 * Root cause analysis.
 *
 * Given a finished execution (status, error, record, verification), it
 * classifies *why* the outcome happened, lists likely causes ranked by how
 * directly the evidence supports them, and recommends actions split by risk —
 * safe retries are suggested, anything that could touch production data is
 * marked as requiring human approval.
 *
 * This is diagnosis, not verdict: it never changes PASS/FAIL/INCONCLUSIVE.
 * Silent-failure detection is the important case — the browser reported
 * success but the independent verifier proved the business outcome failed.
 */

/** The agent's own final payload (non-independent, but honest about failure). */
function agentResultValue(record) {
  const observation = (record?.observations ?? []).find((o) => o.kind === 'agent_result');
  return observation?.result?.value ?? null;
}

/** Did the agent itself report the goal as failed? */
function agentReportedFailure(record) {
  const value = agentResultValue(record);
  if (!value || typeof value !== 'object') return false;
  const status = String(value.status ?? '').toLowerCase();
  return status === 'failure' || status === 'failed' || status === 'error' || value.ok === false;
}

export const ROOT_CAUSE_CLASSES = {
  SUCCESS: { label: 'Verified success', severity: 'info' },
  SILENT_FAILURE: { label: 'Silent business failure', severity: 'critical' },
  VERIFICATION_FAILED: { label: 'Outcome violated', severity: 'high' },
  EVIDENCE_GAP: { label: 'Unprovable — evidence gap', severity: 'medium' },
  AGENT_GOAL_FAILURE: { label: 'Automation failed its goal', severity: 'high' },
  UPSTREAM_ERROR: { label: 'Automation provider error', severity: 'high' },
  TIMEOUT: { label: 'Execution timed out', severity: 'high' },
  CANCELLED: { label: 'Execution cancelled', severity: 'low' },
  NOT_CONFIGURED: { label: 'Integration not configured', severity: 'medium' },
  UNKNOWN: { label: 'Unclassified', severity: 'medium' },
};

const SAFE_ACTION = 'safe';
const APPROVAL_ACTION = 'requires_approval';

/**
 * @param {object} view an execution public view (status, error, record, verification)
 * @returns {{ classification, label, severity, likely_causes, recommended_actions, reason_codes, summary }}
 */
export function analyzeRootCause(view) {
  const status = view?.status ?? 'UNKNOWN';
  const error = view?.error ?? null;
  const record = view?.record ?? null;
  const verification = view?.verification ?? null;
  const verdict = verification?.verdict ?? null;
  const reasonCodes = verification?.details?.reason_codes ?? [];

  const likelyCauses = [];
  const actions = [];
  const reasons = [];
  let classification = 'UNKNOWN';

  // ── Terminal execution failures ──────────────────────────────────────────
  if (status === 'FAILED') {
    const code = error?.code ?? record?.upstream_error?.code ?? 'UNKNOWN';

    if (code === 'TINYFISH_NOT_CONFIGURED') {
      classification = 'NOT_CONFIGURED';
      likelyCauses.push({
        cause: 'TINYFISH_API_KEY is not set, so no browser session could start.',
        confidence: 'certain',
        evidence: 'error.code = TINYFISH_NOT_CONFIGURED',
      });
      actions.push({ action: 'Set TINYFISH_API_KEY in the environment and re-run.', risk: SAFE_ACTION });
      reasons.push('VERIFICATION_UNAVAILABLE');
    } else if (code === 'TINYFISH_NETWORK_ERROR' || code?.startsWith('TINYFISH_')) {
      classification = 'UPSTREAM_ERROR';
      // Our envelope prefixes upstream codes (TINYFISH_INSUFFICIENT_CREDITS),
      // so compare against the bare upstream code when recommending fixes.
      const upstreamCode = code === 'TINYFISH_NETWORK_ERROR' ? code : code.slice('TINYFISH_'.length);
      likelyCauses.push({
        cause: `The automation provider rejected or failed the run (${code}).`,
        confidence: error?.retryable ? 'probable' : 'certain',
        evidence: error?.message ?? record?.upstream_error?.message ?? code,
      });
      reasons.push('UPSTREAM_ERROR');
      if (error?.retryable || record?.upstream_error?.retryable) {
        actions.push({ action: 'Retry the execution — the upstream error is marked retryable.', risk: SAFE_ACTION });
      }
      if (upstreamCode === 'INSUFFICIENT_CREDITS' || upstreamCode === 'FREE_ALLOWANCE_EXHAUSTED') {
        actions.push({ action: 'Top up the TinyFish account balance or wait for the allowance window.', risk: SAFE_ACTION });
      }
      actions.push({
        action: 'Verify the target site is reachable and not blocking automated traffic.',
        risk: SAFE_ACTION,
      });
    } else if (code === 'EXECUTION_TIMEOUT' || status === 'TIMED_OUT') {
      classification = 'TIMEOUT';
      reasons.push('EXECUTION_TIMEOUT');
    } else {
      classification = 'UNKNOWN';
      likelyCauses.push({ cause: error?.message ?? 'Unclassified execution failure.', confidence: 'possible', evidence: code });
    }

    if (verification?.status === 'SKIPPED') reasons.push('EXECUTION_FAILED');
  } else if (status === 'TIMED_OUT') {
    classification = 'TIMEOUT';
    reasons.push('EXECUTION_TIMEOUT');
    likelyCauses.push({
      cause: `The journey exceeded the ${view?.timeout_ms ?? 'configured'}ms watchdog and was cancelled.`,
      confidence: 'certain',
      evidence: 'error.code = EXECUTION_TIMEOUT',
    });
    actions.push({ action: 'Raise execution_timeout_ms or simplify the goal (fewer steps).', risk: SAFE_ACTION });
    actions.push({ action: 'Check whether the target site was slow or rate-limiting us.', risk: SAFE_ACTION });
    actions.push({ action: 'Re-run the journey; a transient slowness is the most common cause.', risk: SAFE_ACTION });
  } else if (status === 'CANCELLED') {
    classification = 'CANCELLED';
    reasons.push('EXECUTION_CANCELLED');
    likelyCauses.push({ cause: 'Cancelled via the API or by a client disconnect.', confidence: 'certain', evidence: 'status = CANCELLED' });
    actions.push({ action: 'Re-run if the cancellation was accidental.', risk: SAFE_ACTION });
  } else if (status === 'INCOMPLETE') {
    classification = 'UPSTREAM_ERROR';
    reasons.push('EXECUTION_FAILED');
    likelyCauses.push({
      cause: 'The SSE stream ended while the run was still active (truncated session).',
      confidence: 'probable',
      evidence: 'record.execution_status = INCOMPLETE',
    });
    actions.push({ action: 'Re-run; if it recurs, inspect the upstream run in the TinyFish console.', risk: SAFE_ACTION });
  }

  // ── Completed executions: the verdict is what matters ────────────────────
  if (status === 'COMPLETED') {
    if (verdict === 'FAIL') {
      const silent = reasonCodes.includes('SILENT_FAILURE') || record?.execution_status === 'COMPLETED';
      classification = silent ? 'SILENT_FAILURE' : 'VERIFICATION_FAILED';
      reasons.push('CHECK_VIOLATED');
      if (silent) reasons.push('SILENT_FAILURE');

      const failedChecks = verification?.details?.failed_checks ?? [];
      likelyCauses.push({
        cause: silent
          ? 'The automation agent reported success, but independently fetched evidence contradicts the requirement.'
          : 'Independent evidence proves a required condition was violated.',
        confidence: 'certain',
        evidence: `failed checks: ${failedChecks.join(', ') || 'n/a'} | reasons: ${reasonCodes.join(', ')}`,
      });
      actions.push({
        action: 'Inspect the cited evidence (page snapshot) for each failed check before changing anything.',
        risk: SAFE_ACTION,
      });
      actions.push({
        action: 'If the condition drifted in production (price, copy, stock), route the fix to the owning team — do not auto-remediate production data.',
        risk: APPROVAL_ACTION,
      });
      actions.push({
        action: 'If evidence shows a stale or wrong page was fetched, re-run the verification (POST /executions/:id/verify).',
        risk: SAFE_ACTION,
      });
    } else if (verdict === 'INCONCLUSIVE') {
      classification = 'EVIDENCE_GAP';
      reasons.push(...reasonCodes.filter((c) => c.startsWith('EVIDENCE_')));
      likelyCauses.push({
        cause: 'Evidence was missing, unreachable or only self-reported, so the requirement could not be proven.',
        confidence: 'certain',
        evidence: `reasons: ${reasonCodes.join(', ')} | inconclusive: ${(verification?.details?.inconclusive_checks ?? []).join(', ')}`,
      });
      actions.push({ action: 'Re-run the execution to collect fresh evidence.', risk: SAFE_ACTION });
      if (reasonCodes.includes('EVIDENCE_UNREACHABLE')) {
        actions.push({ action: 'Check artifact URL reachability (expired presigned links, network egress).', risk: SAFE_ACTION });
      }
      actions.push({ action: 'Tighten the contract: give each check an observable source it can actually read.', risk: SAFE_ACTION });
    } else if (verdict === 'PASS') {
      classification = 'SUCCESS';
      reasons.push('ALL_CHECKS_PASSED');
      likelyCauses.push({
        cause: 'All required conditions were proven by independent evidence.',
        confidence: 'certain',
        evidence: `${(verification?.details?.checks ?? []).length} checks verified`,
      });
    } else if (agentReportedFailure(record)) {
      // The run "completed" but the agent's own payload says the goal failed.
      // Distinct from EVIDENCE_GAP: here the automation itself reports a miss.
      classification = 'AGENT_GOAL_FAILURE';
      reasons.push('AGENT_REPORTED_FAILURE');
      likelyCauses.push({
        cause: 'The automation agent completed the session but reported that it did not achieve the goal.',
        confidence: 'certain',
        evidence: `agent result: ${JSON.stringify(agentResultValue(record)).slice(0, 200)}`,
      });
      actions.push({ action: 'Read the agent result payload to see which step fell short.', risk: SAFE_ACTION });
      actions.push({ action: 'Re-run with a clearer goal or fewer steps if the instruction was ambiguous.', risk: SAFE_ACTION });
      actions.push({ action: 'If the target UI changed (selector drift), update the workflow steps — see the recovery service.', risk: APPROVAL_ACTION });
      if (verification?.status === 'UNAVAILABLE' || !verification?.verdict) {
        reasons.push('NO_CHECKS_DEFINED');
        actions.push({ action: 'Add machine-verifiable checks so this failure is proven by evidence, not only by the agent\u2019s word.', risk: SAFE_ACTION });
      }
    } else {
      // COMPLETED with no verdict at all — honest gap, not success.
      classification = 'EVIDENCE_GAP';
      reasons.push(...(verification?.details?.reason_codes ?? ['NO_CHECKS_DEFINED']));
      likelyCauses.push({
        cause: 'The browser ran, but no verifier could decide (no external engine and no checks).',
        confidence: 'certain',
        evidence: `verification.status = ${verification?.status ?? 'unknown'}`,
      });
      actions.push({ action: 'Add machine-verifiable checks to the contract, or configure VERIFICATION_ENGINE_URL.', risk: SAFE_ACTION });
    }

    if (record?.evidence_fetch_error) {
      likelyCauses.push({
        cause: 'Step screenshots/HTML could not be fetched after the run, so evidence is limited to the SSE stream.',
        confidence: 'certain',
        evidence: `${record.evidence_fetch_error.code}: ${record.evidence_fetch_error.message}`,
      });
      actions.push({ action: 'Re-fetch the run object later (artifacts may still be propagating).', risk: SAFE_ACTION });
    }
  }

  if (classification === 'UNKNOWN') {
    likelyCauses.push({ cause: 'No pattern matched this outcome; inspect the raw event log.', confidence: 'possible', evidence: `status=${status}` });
    actions.push({ action: 'Open the evidence viewer and read the raw event log for this run.', risk: SAFE_ACTION });
  }

  const uniqueReasons = [...new Set(reasons)];

  return {
    classification,
    label: ROOT_CAUSE_CLASSES[classification]?.label ?? classification,
    severity: ROOT_CAUSE_CLASSES[classification]?.severity ?? 'medium',
    likely_causes: likelyCauses,
    recommended_actions: actions,
    reason_codes: uniqueReasons,
    summary: buildSummary({ classification, likelyCauses, actions, verdict, status }),
    analyzed_at: new Date().toISOString(),
  };
}

function buildSummary({ classification, likelyCauses, actions, verdict, status }) {
  const head = likelyCauses[0]?.cause ?? 'No cause identified.';
  const safe = actions.filter((a) => a.risk === SAFE_ACTION).length;
  const gated = actions.length - safe;
  const verdictNote = verdict ? ` Verdict: ${verdict}.` : status === 'COMPLETED' ? ' No verdict was produced.' : '';
  const gateNote = gated > 0 ? ` ${gated} action(s) require human approval before execution.` : '';
  return `${head}${verdictNote}${gateNote}`;
}
