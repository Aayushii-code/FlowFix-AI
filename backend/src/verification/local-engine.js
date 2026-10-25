/**
 * FlowFix local verification engine — the independent verifier.
 *
 * Input:  the normalized record (evidence) + the contract's checks + the
 *         evidence model built by evidence.js.
 * Output: one of PASS / FAIL / INCONCLUSIVE with a full reason trail.
 *
 * Independence rules (this is the whole point of the module):
 *  - it never reads execution status as an input to the verdict — a
 *    COMPLETED run means nothing here;
 *  - only `page` / `api` / `database` sources count as independent proof;
 *  - the agent's own report can add context but can NEVER produce PASS or
 *    FAIL on its own (self-reported success ⇒ INCONCLUSIVE);
 *  - missing, unreachable or unreadable evidence ⇒ INCONCLUSIVE, never PASS.
 *
 * When an external verification engine is configured (Meenu's component) it
 * takes precedence; this engine is the fallback that still works offline.
 */
import { evaluateOperator, applyTransform } from '../checks/operators.js';
import { describeReasons, maxSeverity, severityRank } from './reasons.js';
import { evidenceReferences } from './evidence.js';

export const LOCAL_ENGINE_ID = 'flowfix-local-verification/1';

const INDEPENDENT_SOURCES = new Set(['page', 'api', 'database', 'sandbox']);

/** Read `a.b[0].c` out of a plain object/array. Returns undefined if absent. */
export function readPath(value, path) {
  if (!path) return value;
  if (value === null || value === undefined) return undefined;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cursor = value;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Concatenate all successfully fetched page text for text-style checks. */
function pageText(evidence) {
  return (evidence.pages ?? [])
    .filter((page) => page.ok)
    .map((page) => page.text)
    .join('\n');
}

/** Resolve a check's observed value from its declared evidence source. */
function resolveObserved(check, { record, evidence, externalResults }) {
  const source = check.source ?? 'page';

  if (source === 'page') {
    const text = pageText(evidence);
    if (check.pattern) {
      const match = new RegExp(check.pattern, 'i').exec(text);
      if (!match) return { observed: undefined, ref: null, source };
      const captured = match[1] ?? match[0];
      return { observed: captured, ref: `page:${(evidence.pages ?? []).find((p) => p.ok)?.url ?? ''}`, source };
    }
    if (!text) return { observed: undefined, ref: null, source };
    return { observed: text, ref: `page:${(evidence.pages ?? []).find((p) => p.ok)?.url ?? ''}`, source };
  }

  if (source === 'agent_report' || source === 'observation') {
    const root =
      source === 'agent_report' ? evidence.agent_report?.value : (record?.observations ?? []);
    const observed = readPath(root, check.path);
    return { observed, ref: evidence.agent_report?.present ? `agent_report:${evidence.agent_report.source}` : null, source };
  }

  // api / database / sandbox results are supplied by the caller that ran the
  // independent query (cross-system verification). `via` lets one connector
  // step feed several checks (key is the check's own id, via is the step).
  const bucket = externalResults?.[source];
  if (!bucket) return { observed: undefined, ref: null, source };
  const entry = bucket[check.via ?? check.key];
  if (entry === undefined) return { observed: undefined, ref: null, source };
  // Entries may be plain values, or { value, evidence_ref } wrappers carrying
  // their own provenance reference.
  if (entry !== null && typeof entry === 'object' && 'value' in entry) {
    return { observed: readPath(entry.value, check.path), ref: entry.evidence_ref ?? null, source };
  }
  return { observed: readPath(entry, check.path ?? check.extract), ref: null, source };
}

function evaluateCheck(check, context) {
  const source = check.source ?? 'page';
  const independent = INDEPENDENT_SOURCES.has(source);
  const severity = check.severity ?? 'medium';
  const required = check.required !== false;

  // Source availability is decided BEFORE any operator runs: an unavailable
  // source means "we do not know", so `exists` must not be read as "absent"
  // and no operator may turn ignorance into a verdict.
  const availability = sourceAvailability(source, context);
  if (!availability.available) {
    return {
      key: check.key,
      description: check.description ?? null,
      source,
      independent,
      operator: check.operator ?? 'equals',
      expected: check.expected ?? null,
      observed: null,
      status: 'inconclusive',
      severity,
      required,
      reason_codes: [availability.reason],
      evidence_ref: null,
    };
  }

  const { observed: raw, ref } = resolveObserved(check, context);
  const observed = applyTransform(raw, check.transform);

  const result = evaluateOperator(check, observed);
  const reasons = [];

  let status;
  if (result.ok === null) {
    status = 'inconclusive';
    reasons.push(result.reason ?? 'EVIDENCE_MISSING');
  } else if (!independent) {
    // Self-report: record what the agent claimed, but never prove anything.
    status = 'inconclusive';
    reasons.push('EVIDENCE_NOT_INDEPENDENT');
    if (result.ok === false) reasons.push('UNVERIFIED_VIOLATION');
  } else if (result.ok) {
    status = 'pass';
  } else {
    status = 'fail';
    reasons.push('CHECK_VIOLATED');
  }

  return {
    key: check.key,
    description: check.description ?? null,
    source,
    independent,
    operator: check.operator ?? 'equals',
    expected: check.expected ?? null,
    observed: observed === undefined ? null : observed,
    status,
    severity,
    required,
    reason_codes: reasons,
    evidence_ref: ref,
  };
}

/**
 * Can this check's evidence source be consulted at all?
 * Distinguishes "source unreachable / never supplied" (INCONCLUSIVE) from
 * "source reachable, value genuinely absent" (a real, provable failure).
 */
function sourceAvailability(source, context) {
  const { evidence, externalResults, record } = context;

  if (source === 'page') {
    if ((evidence.pages ?? []).some((page) => page.ok)) return { available: true };
    if (evidence.page_fetch_attempted) return { available: false, reason: 'EVIDENCE_UNREACHABLE' };
    return { available: false, reason: 'EVIDENCE_MISSING' };
  }

  if (source === 'agent_report' || source === 'observation') {
    if (source === 'agent_report') {
      return evidence.agent_report?.present
        ? { available: true }
        : { available: false, reason: 'EVIDENCE_MISSING' };
    }
    return (record?.observations ?? []).length > 0
      ? { available: true }
      : { available: false, reason: 'EVIDENCE_MISSING' };
  }

  // api / database / sandbox: only available when the caller that ran the
  // independent query actually supplied results for this source.
  return externalResults?.[source]
    ? { available: true }
    : { available: false, reason: 'EVIDENCE_MISSING' };
}

/** A check blocked because its dependency did not pass — inconclusive, never a failure. */
function blockedCheck(check, dependsOn, reasonCodes, unmet) {
  const source = check.source ?? 'page';
  return {
    key: check.key,
    description: check.description ?? null,
    source,
    independent: INDEPENDENT_SOURCES.has(source),
    operator: check.operator ?? 'equals',
    expected: check.expected ?? null,
    observed: null,
    status: 'inconclusive',
    severity: check.severity ?? 'medium',
    required: check.required !== false,
    reason_codes: reasonCodes,
    evidence_ref: null,
    skipped: true,
    depends_on: dependsOn,
    unmet_dependencies: unmet,
  };
}

/** Resolve one operand of a cross-system comparison from its evidence source. */
function resolveOperand(operand, context) {
  const miss = (source = null, independent = false) => ({
    found: false,
    value: undefined,
    ref: null,
    independent,
    source,
  });
  if (!operand || typeof operand !== 'object') return miss();
  const source = operand.source;

  if (source === 'page') {
    const pages = (context.evidence?.pages ?? []).filter((page) => page.ok);
    if (pages.length === 0) return miss('page');
    const text = pages.map((page) => page.text).join('\n');
    const ref = `page:${pages[0].url}`;
    if (operand.pattern) {
      const match = new RegExp(operand.pattern, 'i').exec(text);
      return match ? { found: true, value: match[1] ?? match[0], ref, independent: true, source } : miss('page', true);
    }
    return text
      ? { found: true, value: text, ref, independent: true, source }
      : miss('page', true);
  }

  if (source === 'agent_report' || source === 'observation') {
    if (source === 'agent_report') {
      return context.evidence?.agent_report?.present
        ? {
            found: true,
            value: readPath(context.evidence.agent_report.value, operand.path),
            ref: `agent_report:${context.evidence.agent_report.source}`,
            independent: false,
            source,
          }
        : miss('agent_report', false);
    }
    return (context.record?.observations ?? []).length > 0
      ? { found: true, value: readPath(context.record.observations, operand.path), ref: null, independent: false, source }
      : miss('observation', false);
  }

  // api / database / sandbox — results supplied by the connector run.
  const bucket = context.externalResults?.[source];
  if (!bucket) return miss(source, true);
  const entry = bucket[operand.key];
  if (entry === undefined) return miss(source, true);
  const value = entry !== null && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  const ref = entry !== null && typeof entry === 'object' && entry.evidence_ref ? entry.evidence_ref : null;
  const resolved = operand.path ? readPath(value, operand.path) : value;
  return resolved === undefined
    ? { found: false, value: undefined, ref, independent: true, source }
    : { found: true, value: resolved, ref, independent: true, source };
}

/**
 * Evaluate a cross-system comparison: two independently observed values
 * (or one value against a literal) compared with a shared operator.
 */
function evaluateComparison(comparison, context) {
  const severity = comparison.severity ?? 'high';
  const required = comparison.required !== false;
  const operator = comparison.operator ?? 'equals';
  const left = resolveOperand(comparison.left, context);
  const rightIsOperand = Boolean(comparison.right && typeof comparison.right === 'object' && 'source' in comparison.right);
  const right = rightIsOperand
    ? resolveOperand(comparison.right, context)
    : { found: true, value: comparison.right, ref: null, independent: true, source: 'literal' };
  const crossSystems =
    right.source !== 'literal' && Boolean(left.source) && Boolean(right.source) && left.source !== right.source;

  let status;
  let observed = null;
  const reasonCodes = [];

  if (!left.found || !right.found) {
    status = 'inconclusive';
    reasonCodes.push('EVIDENCE_MISSING');
    observed = left.found ? left.value : null;
  } else if (!left.independent || !right.independent) {
    status = 'inconclusive';
    reasonCodes.push('EVIDENCE_NOT_INDEPENDENT');
    observed = left.value;
  } else {
    const result = evaluateOperator({ operator, expected: right.value }, left.value);
    observed = result.actual ?? left.value;
    if (result.ok === null) {
      status = 'inconclusive';
      reasonCodes.push(result.reason ?? 'EVIDENCE_MISSING');
    } else if (result.ok) {
      status = 'pass';
    } else {
      status = 'fail';
      reasonCodes.push(crossSystems ? 'CROSS_SYSTEM_MISMATCH' : 'CHECK_VIOLATED');
      if (!left.found || !right.found) reasonCodes.push('CROSS_SYSTEM_RECORD_MISSING');
    }
  }

  return {
    key: comparison.key ?? `${comparison.left?.key ?? 'left'}_${operator}_${comparison.right?.key ?? 'right'}`,
    description: comparison.description ?? null,
    kind: 'comparison',
    source: crossSystems ? 'cross_system' : (left.source ?? 'unknown'),
    independent: left.independent && right.independent,
    operator,
    expected: right.found ? right.value : null,
    observed,
    status,
    severity,
    required,
    reason_codes: reasonCodes,
    evidence_ref: left.ref ?? right.ref ?? null,
    left: { source: left.source, path: comparison.left?.path ?? null, pattern: comparison.left?.pattern ?? null, evidence_ref: left.ref },
    right: {
      source: right.source,
      path: rightIsOperand ? (comparison.right?.path ?? null) : null,
      value: right.found ? right.value : null,
      evidence_ref: right.ref,
    },
  };
}

/**
 * Produce the verification block for a COMPLETED execution.
 *
 * @param {{
 *   executionId: string,
 *   requirementId: string|null,
 *   requirement: string|null,
 *   checks: object[],
 *   record: object|null,
 *   evidence: object,
 *   externalResults?: Record<string, any>,
 * }} input
 */
export function verifyWithChecks({
  executionId,
  requirementId = null,
  requirement = null,
  checks = [],
  comparisons = [],
  record = null,
  evidence,
  externalResults = null,
}) {
  const timestamp = new Date().toISOString();
  const list = Array.isArray(checks) ? checks : [];
  const comparisonList = Array.isArray(comparisons) ? comparisons : [];

  // Comparisons are verifiable on their own (e.g. a pure REST-vs-SQL
  // equality), so only an entirely empty contract has nothing to prove.
  if (list.length === 0 && comparisonList.length === 0) {
    return {
      status: 'UNAVAILABLE',
      verdict: null,
      details: {
        execution_id: executionId,
        requirement_id: requirementId,
        reason_code: 'NO_CHECKS_DEFINED',
        reason_codes: ['NO_CHECKS_DEFINED'],
        reasons: describeReasons(['NO_CHECKS_DEFINED']),
        severity: 'medium',
        explanation:
          'No machine-verifiable checks were defined for this requirement, so no verdict can be produced.',
        timestamp,
        engine: LOCAL_ENGINE_ID,
      },
    };
  }

  const context = { record, evidence, externalResults };
  const byKey = new Map(list.map((check) => [check.key, check]));

  // Dependency-aware evaluation: a check whose dependency did not pass is
  // INCONCLUSIVE (DEPENDENCY_NOT_MET) — an unmet precondition is missing
  // evidence, not a proven violation.
  const resultsByKey = new Map();
  const visiting = new Set();
  const evaluateOne = (check) => {
    if (resultsByKey.has(check.key)) return resultsByKey.get(check.key);
    const deps = Array.isArray(check.depends_on) ? check.depends_on : [];
    let result;
    if (visiting.has(check.key)) {
      result = blockedCheck(check, deps, ['DEPENDENCY_NOT_MET'], ['<cyclic>']);
    } else {
      visiting.add(check.key);
      const unmet = deps.filter((dep) => {
        const depCheck = byKey.get(dep);
        return !depCheck || evaluateOne(depCheck).status !== 'pass';
      });
      result = unmet.length
        ? blockedCheck(check, deps, ['DEPENDENCY_NOT_MET'], unmet)
        : evaluateCheck(check, context);
      result.depends_on = deps;
      result.unmet_dependencies = unmet;
      visiting.delete(check.key);
    }
    resultsByKey.set(check.key, result);
    return result;
  };

  const results = list.map(evaluateOne);
  const comparisonResults = comparisonList.map((comparison) =>
    evaluateComparison(comparison, context),
  );
  const allResults = [...results, ...comparisonResults];
  const crossSystem =
    comparisonResults.length > 0 ||
    allResults.some((r) => r.source === 'api' || r.source === 'database');

  const required = allResults.filter((r) => r.required);
  const failedRequired = required.filter((r) => r.status === 'fail');
  const inconclusiveRequired = required.filter((r) => r.status === 'inconclusive');
  const failedOptional = allResults.filter((r) => !r.required && r.status === 'fail');

  const reasonCodes = [];
  let verdict;

  if (failedRequired.length > 0) {
    verdict = 'FAIL';
    const mismatched = allResults.some((r) => r.reason_codes.includes('CROSS_SYSTEM_MISMATCH'));
    reasonCodes.push(mismatched ? 'CROSS_SYSTEM_MISMATCH' : 'CHECK_VIOLATED');
    if (mismatched && allResults.some((r) => r.reason_codes.includes('CHECK_VIOLATED'))) {
      reasonCodes.push('CHECK_VIOLATED');
    }
    // The silent-failure signal: the browser run itself reported success.
    if (record?.execution_status === 'COMPLETED') reasonCodes.push('SILENT_FAILURE');
    if (allResults.some((r) => r.reason_codes.includes('EVIDENCE_NOT_INDEPENDENT'))) {
      reasonCodes.push('EVIDENCE_NOT_INDEPENDENT');
    }
  } else if (inconclusiveRequired.length > 0) {
    verdict = 'INCONCLUSIVE';
    for (const r of inconclusiveRequired) reasonCodes.push(...r.reason_codes);
    if (failedOptional.length > 0) reasonCodes.push('UNVERIFIED_VIOLATION');
  } else {
    verdict = 'PASS';
    reasonCodes.push('ALL_CHECKS_PASSED');
    if (failedOptional.length > 0) reasonCodes.push('EVIDENCE_INCOMPLETE');
  }

  const agentClaimedSuccess = evidence.agent_report?.present && record?.execution_status === 'COMPLETED';
  if (agentClaimedSuccess && verdict === 'FAIL') {
    // already flagged via SILENT_FAILURE
  } else if (agentClaimedSuccess && verdict === 'INCONCLUSIVE') {
    reasonCodes.push('EVIDENCE_NOT_INDEPENDENT');
  }

  const uniqueCodes = [...new Set(reasonCodes)];
  const severity =
    verdict === 'PASS'
      ? 'info'
      : // Worst of: reason-code severity (SILENT_FAILURE ⇒ critical) and the
        // declared severity of the checks that actually failed.
        worstSeverity([
          maxSeverity(uniqueCodes),
          ...failedRequired.map((r) => r.severity),
        ]);

  const evidenceRefs = evidenceReferences(evidence, allResults);

  const explanation = buildExplanation({ verdict, required, failedRequired, inconclusiveRequired, requirement });

  return {
    status: 'COMPLETED',
    verdict,
    details: {
      execution_id: executionId,
      requirement_id: requirementId,
      requirement: requirement ?? null,
      engine: LOCAL_ENGINE_ID,
      independent_verification: true,
      expected_result: allResults.map((r) => ({
        key: r.key,
        description: r.description,
        source: r.source,
        operator: r.operator,
        expected: r.expected,
        required: r.required,
      })),
      observed_result: allResults.map((r) => ({
        key: r.key,
        status: r.status,
        observed: r.observed,
        evidence_ref: r.evidence_ref,
      })),
      checks: allResults,
      comparisons: comparisonResults,
      cross_system: crossSystem,
      failed_checks: failedRequired.map((r) => r.key),
      inconclusive_checks: inconclusiveRequired.map((r) => r.key),
      failed_optional_checks: failedOptional.map((r) => r.key),
      evidence_references: evidenceRefs,
      reason_codes: uniqueCodes,
      reasons: describeReasons(uniqueCodes),
      severity,
      explanation,
      timestamp,
    },
  };
}

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

/** Worst (most severe) label across a list of severity labels. */
function worstSeverity(labels = []) {
  return labels.reduce(
    (acc, label) => (SEVERITY_ORDER.indexOf(label) > SEVERITY_ORDER.indexOf(acc) ? label : acc),
    'info',
  );
}

function buildExplanation({ verdict, required, failedRequired, inconclusiveRequired, requirement }) {
  const requirementLine = requirement ? `Requirement: "${requirement}" ` : '';

  if (verdict === 'PASS') {
    return (
      `${requirementLine}proven: all ${required.length} required condition(s) were verified ` +
      'against evidence fetched independently of the automation agent.'
    );
  }
  if (verdict === 'FAIL') {
    const detail = failedRequired
      .map((r) => `${r.key} (expected ${JSON.stringify(r.expected)}, observed ${JSON.stringify(r.observed)})`)
      .join('; ');
    return (
      `${requirementLine}violated: independent evidence contradicts ${failedRequired.length} ` +
      `required condition(s): ${detail}.`
    );
  }
  const detail = inconclusiveRequired
    .map((r) => `${r.key} [${r.reason_codes.join(', ')}]`)
    .join('; ');
  return (
    `${requirementLine}could not be proven: ${inconclusiveRequired.length} of ${required.length} ` +
    `required condition(s) lack sufficient independent evidence: ${detail}. ` +
    'Missing evidence is never treated as success.'
  );
}

/** Rank helper used by dashboards to sort by business impact. */
export function severityOf(details) {
  return details?.severity ?? 'medium';
}

export { severityRank };
