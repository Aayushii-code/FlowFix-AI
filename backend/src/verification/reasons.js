/**
 * Reason code catalog.
 *
 * Every verdict, failure and inconclusive outcome must be able to explain
 * itself: consumers get stable machine codes plus a human explanation instead
 * of an opaque status. Codes are append-only — retired codes stay listed so
 * historical audit records keep decoding.
 *
 * Categories:
 *   verification — why a verdict came out the way it did
 *   execution    — why a run ended the way it did
 *   evidence     — what was wrong with the evidence
 *   system       — configuration/infrastructure causes
 */

export const REASON_CODES = {
  // ── verification ─────────────────────────────────────────────────────────
  ALL_CHECKS_PASSED: {
    category: 'verification',
    severity: 'info',
    summary: 'Every required check was proven true by independent evidence.',
  },
  CHECK_VIOLATED: {
    category: 'verification',
    severity: 'high',
    summary: 'Independent evidence proves a required condition was violated.',
  },
  SILENT_FAILURE: {
    category: 'verification',
    severity: 'critical',
    summary:
      'Automation reported success, but evidence shows the business outcome was NOT achieved.',
  },
  AGENT_REPORTED_FAILURE: {
    category: 'verification',
    severity: 'high',
    summary: 'The automation agent itself reported that the outcome was not achieved.',
  },
  UNVERIFIED_VIOLATION: {
    category: 'evidence',
    severity: 'medium',
    summary:
      'A violation is claimed only by the agent self-report; no independent evidence confirms it.',
  },
  NO_CHECKS_DEFINED: {
    category: 'verification',
    severity: 'medium',
    summary: 'The execution carries no machine-verifiable checks, so no verdict can be produced.',
  },
  CHECKS_OPTIONAL_ONLY: {
    category: 'verification',
    severity: 'medium',
    summary: 'Only optional checks were defined; no required condition to prove.',
  },

  // ── evidence ─────────────────────────────────────────────────────────────
  EVIDENCE_MISSING: {
    category: 'evidence',
    severity: 'medium',
    summary: 'Required evidence for a check was not present in the execution record.',
  },
  EVIDENCE_UNREACHABLE: {
    category: 'evidence',
    severity: 'medium',
    summary: 'Independent evidence could not be fetched (network/timeout/HTTP error).',
  },
  EVIDENCE_NOT_INDEPENDENT: {
    category: 'evidence',
    severity: 'high',
    summary: 'Only the agent\u2019s self-reported output was available; it is not independent proof.',
  },
  EVIDENCE_CONTRADICTORY: {
    category: 'evidence',
    severity: 'high',
    summary: 'Sources disagree about the observed value.',
  },
  EVIDENCE_INCOMPLETE: {
    category: 'evidence',
    severity: 'medium',
    summary: 'Evidence covers only part of the required conditions.',
  },

  // ── execution ────────────────────────────────────────────────────────────
  EXECUTION_FAILED: {
    category: 'execution',
    severity: 'high',
    summary: 'The workflow execution failed before evidence could be collected.',
  },
  EXECUTION_TIMEOUT: {
    category: 'execution',
    severity: 'high',
    summary: 'The execution exceeded its watchdog timeout.',
  },
  EXECUTION_CANCELLED: {
    category: 'execution',
    severity: 'low',
    summary: 'The execution was cancelled before completion.',
  },
  UPSTREAM_ERROR: {
    category: 'execution',
    severity: 'high',
    summary: 'The automation provider returned an error.',
  },
  VERIFICATION_UNAVAILABLE: {
    category: 'system',
    severity: 'medium',
    summary: 'No verification engine is configured, so the requirement is not verified.',
  },

  // ── system ───────────────────────────────────────────────────────────────
  VERIFICATION_ENGINE_ERROR: {
    category: 'system',
    severity: 'high',
    summary: 'The verification engine errored or timed out; verdict withheld.',
  },
  CONNECTOR_NOT_CONFIGURED: {
    category: 'system',
    severity: 'medium',
    summary: 'A required cross-system connector is not configured; that leg cannot be proven.',
  },
  SANDBOX_DATA: {
    category: 'system',
    severity: 'info',
    summary: 'Result derives from sandbox/simulated data, labelled as such.',
  },
};

/** Resolve codes to { code, category, severity, summary }, dropping unknowns. */
export function describeReasons(codes = []) {
  const seen = [];
  for (const code of codes) {
    if (seen.some((r) => r.code === code)) continue;
    const meta = REASON_CODES[code];
    seen.push({
      code,
      category: meta?.category ?? 'unknown',
      severity: meta?.severity ?? 'medium',
      summary: meta?.summary ?? code,
    });
  }
  return seen;
}

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

/** Highest severity across a set of codes (defaults to 'info'). */
export function maxSeverity(codes = []) {
  return codes.reduce((acc, code) => {
    const severity = REASON_CODES[code]?.severity ?? 'medium';
    return SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(acc) ? severity : acc;
  }, 'info');
}

/** Most severe per-check severity label. */
export function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? 2 : index;
}
