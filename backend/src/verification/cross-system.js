/**
 * Cross-system verification engine.
 *
 * One business contract, several systems: browser page evidence, a REST API
 * and a SQL database are consulted **independently**, then every check and
 * every cross-system comparison is evaluated by the same verdict authority
 * (verifyWithChecks) so PASS / FAIL / INCONCLUSIVE keep their meaning.
 *
 * Guarantees:
 *  - each connector failure (timeout, auth, unreachable) makes the affected
 *    checks INCONCLUSIVE with a typed reason — never PASS, never a guess;
 *  - comparisons require BOTH sides from independent sources; a side coming
 *    from the agent's self-report can only make it INCONCLUSIVE;
 *  - dependencies order evaluation; an unmet dependency is INCONCLUSIVE
 *    (DEPENDENCY_NOT_MET), not a failure;
 *  - sanitized connector evidence is returned so it can be attached to the
 *    linked execution and shown in the Evidence Viewer.
 */
import { verifyWithChecks } from './local-engine.js';
import { describeReasons } from './reasons.js';
import { collectEvidence } from './evidence.js';
import { RestConnector } from '../connectors/rest.js';
import { SqlConnector } from '../connectors/sql.js';

const SYSTEM_LABELS = {
  page: { id: 'browser', label: 'Browser / page' },
  api: { id: 'rest', label: 'REST API' },
  database: { id: 'database', label: 'Database (SQL)' },
  sandbox: { id: 'sandbox', label: 'Sandbox transaction' },
  cross_system: { id: 'cross', label: 'Cross-system comparison' },
  agent_report: { id: 'agent', label: 'Automation agent (self-report)' },
  observation: { id: 'agent', label: 'Automation agent (self-report)' },
};

function buildConnectors(connectors = {}, steps = {}) {
  const restSteps = Array.isArray(steps.rest) ? steps.rest : [];
  const sqlSteps = Array.isArray(steps.sql) ? steps.sql : [];
  return {
    rest: restSteps.length > 0 ? new RestConnector(connectors.rest ?? {}) : null,
    sql: sqlSteps.length > 0 ? new SqlConnector(connectors.sql ?? {}) : null,
    restSteps,
    sqlSteps,
  };
}

/**
 * Run one cross-system verification.
 *
 * @param {{
 *   executionId?: string|null,
 *   requirementId?: string|null,
 *   requirement?: string|null,
 *   checks: object[],
 *   comparisons?: object[],
 *   steps?: { rest?: object[], sql?: object[] },
 *   connectors?: { rest?: object, sql?: object },
 *   record?: object|null,
 *   pageUrl?: string|null,
 *   fetcher?: Function,
 * }} input
 */
export async function runCrossSystemVerification({
  executionId = null,
  requirementId = null,
  requirement = null,
  checks = [],
  comparisons = [],
  steps = {},
  connectors = {},
  record = null,
  pageUrl = null,
  fetcher = undefined,
}) {
  const { rest, sql, restSteps, sqlSteps } = buildConnectors(connectors, steps);
  const externalResults = { api: {}, database: {} };
  const evidenceItems = [];
  const connectorErrors = [];

  // ── REST legs ────────────────────────────────────────────────────────────
  for (const step of restSteps) {
    const outcome = await rest.run(step);
    if (outcome.evidence) evidenceItems.push(outcome.evidence);
    if (outcome.error && outcome.value === null) {
      connectorErrors.push({ key: step.key, system: 'rest', ...outcome.error });
      continue;
    }
    if (outcome.error) connectorErrors.push({ key: step.key, system: 'rest', ...outcome.error });
    if (outcome.value !== null) {
      externalResults.api[step.key] = { value: outcome.value, evidence_ref: `api:${step.key}` };
    }
  }

  // ── SQL legs ─────────────────────────────────────────────────────────────
  for (const step of sqlSteps) {
    const outcome = await sql.run(step);
    if (outcome.evidence) evidenceItems.push(outcome.evidence);
    if (outcome.error) connectorErrors.push({ key: step.key, system: 'database', ...outcome.error });
    if (outcome.value !== null && outcome.value !== undefined) {
      externalResults.database[step.key] = { value: outcome.value, evidence_ref: `sql:${step.key}` };
    }
  }

  // ── Browser leg (only when a check/comparison actually reads the page) ───
  const needsPage = [...checks, ...comparisons].some((item) => operandUsesSource(item, 'page'));
  const evidence = needsPage
    ? await collectEvidence({ record, targetUrl: pageUrl, fetcher })
    : {
        pages: [],
        agent_report: { present: Boolean(record), value: null, independent: false },
        steps: [],
        artifacts: [],
        page_fetch_ok: false,
        page_fetch_attempted: false,
      };

  // ── One verdict authority for every system ───────────────────────────────
  const verification = verifyWithChecks({
    executionId: executionId ?? 'cross-system',
    requirementId,
    requirement,
    checks,
    comparisons,
    record,
    evidence,
    externalResults,
  });

  // Surface typed connector failures as reasons (status stays INCONCLUSIVE).
  if (connectorErrors.length > 0 && verification.status === 'COMPLETED') {
    const codes = new Set(verification.details.reason_codes ?? []);
    for (const check of verification.details.checks ?? []) {
      const failure = connectorErrors.find((error) => error.key === check.key);
      if (failure && check.status === 'inconclusive') {
        check.reason_codes = [failure.code];
        check.connector_error = { code: failure.code, message: failure.message };
      }
      for (const code of check.reason_codes ?? []) codes.add(code);
    }
    verification.details.reason_codes = [...codes];
    verification.details.reasons = describeReasons([...codes]);
    verification.details.connector_errors = connectorErrors;
  }

  const systems = summarizeSystems(verification.details);
  verification.details.systems = systems;
  verification.details.execution_id = executionId ?? verification.details.execution_id;
  verification.details.cross_system = true;

  return {
    verification,
    evidence: {
      api_responses: evidenceItems.filter((item) => item.kind === 'api_response'),
      database_results: evidenceItems.filter((item) => item.kind === 'database_result'),
    },
    connector_errors: connectorErrors,
    systems,
  };
}

/** Does this check/comparison read from a given source? */
function operandUsesSource(item, source) {
  if (item?.source === source) return true;
  if (item?.left?.source === source || item?.right?.source === source) return true;
  return false;
}

/**
 * Per-system roll-up for the UI: which system proved what, with expected vs
 * observed values for every check and comparison.
 */
export function summarizeSystems(details) {
  const buckets = new Map();
  const bucketFor = (result) => {
    if (result.kind === 'comparison') return result.source === 'cross_system' ? 'cross' : result.source;
    return result.source ?? 'unknown';
  };

  for (const check of details.checks ?? []) {
    const source = bucketFor(check);
    const meta = SYSTEM_LABELS[source] ?? { id: source, label: source };
    if (!buckets.has(meta.id)) {
      buckets.set(meta.id, {
        id: meta.id,
        label: meta.label,
        source,
        pass: 0,
        fail: 0,
        inconclusive: 0,
        checks: [],
      });
    }
    const bucket = buckets.get(meta.id);
    bucket[check.status] += 1;
    bucket.checks.push({
      key: check.key,
      description: check.description,
      kind: check.kind ?? 'check',
      status: check.status,
      operator: check.operator,
      expected: check.expected,
      observed: check.observed,
      evidence_ref: check.evidence_ref,
      reason_codes: check.reason_codes,
      independent: check.independent,
      ...(check.left ? { left: check.left, right: check.right } : {}),
      ...(check.connector_error ? { connector_error: check.connector_error } : {}),
    });
  }

  // Comparisons are already part of details.checks, so the loop above is the
  // single place they are bucketed — counting them twice would corrupt the
  // per-system roll-up the dashboard renders.
  return [...buckets.values()];
}
