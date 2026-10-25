/**
 * Assurance endpoints: the natural-language requirement compiler and
 * e-commerce transaction assurance.
 *
 * The compiler returns a *draft* for human review — it never persists
 * anything. The e-commerce verifier only ever evaluates a sandbox snapshot
 * handed to it; it cannot initiate a purchase.
 */
import { Router } from 'express';
import { asyncRoute, ValidationError, NotFoundError, AppError } from '../errors.js';
import { compileRequirement } from '../contracts/compiler.js';
import { ECOMMERCE_RULES, verifySandboxTransaction } from '../assurance/ecommerce.js';
import { normalizeChecks, CHECK_SOURCES } from '../checks/validate.js';
import { OPERATOR_NAMES } from '../checks/operators.js';
import { runCrossSystemVerification } from '../verification/cross-system.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE']);

function requireKeyedArray(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${label} must be an array`);
  return raw;
}

function validateOperand(operand, label) {
  if (!operand || typeof operand !== 'object') {
    throw new ValidationError(`${label} must be an object { source, path?, pattern?, key? }`);
  }
  if (!CHECK_SOURCES.includes(operand.source)) {
    throw new ValidationError(`${label}.source must be one of: ${CHECK_SOURCES.join(', ')}`);
  }
  if (['api', 'database', 'sandbox'].includes(operand.source) && !operand.key) {
    throw new ValidationError(`${label}.key is required for source "${operand.source}" (the connector step key)`);
  }
  if (operand.path !== undefined && typeof operand.path !== 'string') {
    throw new ValidationError(`${label}.path must be a string`);
  }
  if (operand.pattern !== undefined && typeof operand.pattern !== 'string') {
    throw new ValidationError(`${label}.pattern must be a string`);
  }
  return {
    source: operand.source,
    ...(operand.key ? { key: operand.key } : {}),
    ...(operand.path ? { path: operand.path } : {}),
    ...(operand.pattern ? { pattern: operand.pattern } : {}),
  };
}

function validateComparisons(raw) {
  const list = requireKeyedArray(raw, 'comparisons');
  return list.map((comparison, index) => {
    const at = `comparisons[${index}]`;
    if (!comparison || typeof comparison !== 'object') throw new ValidationError(`${at} must be an object`);
    if (comparison.operator !== undefined && !OPERATOR_NAMES.includes(comparison.operator)) {
      throw new ValidationError(`${at}.operator must be one of: ${OPERATOR_NAMES.join(', ')}`);
    }
    if (!comparison.left) throw new ValidationError(`${at}.left is required`);
    const rightIsOperand = Boolean(comparison.right && typeof comparison.right === 'object' && 'source' in comparison.right);
    return {
      key: typeof comparison.key === 'string' && comparison.key.trim() ? comparison.key.trim() : `compare_${index}`,
      description: typeof comparison.description === 'string' ? comparison.description : null,
      operator: comparison.operator ?? 'equals',
      severity: comparison.severity ?? 'high',
      required: comparison.required !== false,
      left: validateOperand(comparison.left, `${at}.left`),
      right: rightIsOperand ? validateOperand(comparison.right, `${at}.right`) : comparison.right ?? null,
    };
  });
}

function validateRestSteps(raw) {
  const list = requireKeyedArray(raw, 'steps.rest');
  return list.map((step, index) => {
    const at = `steps.rest[${index}]`;
    if (!step || typeof step !== 'object') throw new ValidationError(`${at} must be an object`);
    if (typeof step.key !== 'string' || !step.key.trim()) throw new ValidationError(`${at}.key must be a non-empty string`);
    if (typeof step.url !== 'string' || !/^https?:\/\//i.test(step.url)) {
      throw new ValidationError(`${at}.url must be an absolute http(s) URL`);
    }
    if (step.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(step.method).toUpperCase())) {
      throw new ValidationError(`${at}.method must be GET, POST, PUT, PATCH or DELETE`);
    }
    if (step.headers !== undefined && (typeof step.headers !== 'object' || Array.isArray(step.headers))) {
      throw new ValidationError(`${at}.headers must be an object`);
    }
    return {
      key: step.key.trim(),
      method: String(step.method ?? 'GET').toUpperCase(),
      url: step.url,
      ...(step.headers ? { headers: step.headers } : {}),
      ...(step.body !== undefined ? { body: step.body } : {}),
      ...(step.timeout_ms !== undefined ? { timeout_ms: Number(step.timeout_ms) } : {}),
      ...(step.retries !== undefined ? { retries: Number(step.retries) } : {}),
    };
  });
}

function validateSqlSteps(raw) {
  const list = requireKeyedArray(raw, 'steps.sql');
  return list.map((step, index) => {
    const at = `steps.sql[${index}]`;
    if (!step || typeof step !== 'object') throw new ValidationError(`${at} must be an object`);
    if (typeof step.key !== 'string' || !step.key.trim()) throw new ValidationError(`${at}.key must be a non-empty string`);
    if (typeof step.sql !== 'string' || !step.sql.trim()) throw new ValidationError(`${at}.sql must be a non-empty string`);
    if (step.params !== undefined && !Array.isArray(step.params)) throw new ValidationError(`${at}.params must be an array`);
    return { key: step.key.trim(), sql: step.sql, ...(step.params ? { params: step.params } : {}) };
  });
}

export function createAssuranceRoutes({ engine, repos } = {}) {
  const router = Router();

  /**
   * POST /api/contracts/compile
   * Plain English in → structured, reviewable contract draft out.
   */
  router.post('/contracts/compile', asyncRoute((req, res) => {
    const text = req.body?.requirement ?? req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ValidationError('requirement must be a non-empty string', {
        example: 'Check whether iPhone 17 Pro is available for less than ₹1,20,000 and can be added to the cart.',
      });
    }
    const url = typeof req.body?.url === 'string' && req.body.url.trim() ? req.body.url.trim() : null;

    const result = compileRequirement(text, { url });

    res.json({
      ...result,
      saved: false,
      next_step: {
        method: 'POST',
        path: '/api/contracts',
        note: 'Review and edit the draft (add the url, resolve ambiguities), then POST it to persist it as a contract.',
      },
    });
  }));

  /**
   * GET /api/assurance/ecommerce/rules — the rule catalog, so a UI can render
   * pickers without hardcoding the list.
   */
  router.get('/assurance/ecommerce/rules', (_req, res) => {
    res.json({
      sandbox_only: true,
      note: 'FlowFix verifies transaction snapshots; it never initiates or modifies real orders or payments.',
      rules: Object.entries(ECOMMERCE_RULES).map(([type, rule]) => ({
        type,
        label: rule.label,
        description: rule.description,
        params: rule.params,
        severity: rule.severity,
      })),
    });
  });

  /**
   * POST /api/assurance/ecommerce/verify
   * Verify a sandbox transaction snapshot against e-commerce expectations.
   */
  router.post('/assurance/ecommerce/verify', asyncRoute((req, res) => {
    const { transaction, expectations, requirement, requirement_id: requirementId } = req.body ?? {};
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
      throw new ValidationError('transaction must be an object — the sandbox snapshot to verify');
    }
    const result = verifySandboxTransaction({
      transaction,
      expectations,
      requirementId: requirementId ?? null,
      requirement: typeof requirement === 'string' ? requirement : null,
    });
    res.json(result);
  }));

  /**
   * POST /api/cross-system/verify
   * One requirement → checks across browser + REST + SQL (+ comparisons),
   * evaluated by the single independent verdict authority.
   */
  router.post('/cross-system/verify', asyncRoute(async (req, res) => {
    const body = req.body ?? {};

    let contract = null;
    if (body.contract_id !== undefined && body.contract_id !== null) {
      contract = repos?.contracts?.get(String(body.contract_id));
      if (!contract) throw new NotFoundError(`Contract ${body.contract_id} not found`);
    }

    let executionView = null;
    if (body.execution_id !== undefined && body.execution_id !== null) {
      executionView = engine.get(String(body.execution_id)); // 404s if unknown
      if (!TERMINAL.has(executionView.status)) {
        throw new AppError(
          'EXECUTION_NOT_FINISHED',
          `Cross-system verification links to a finished execution; current status is ${executionView.status}`,
          { httpStatus: 409 },
        );
      }
    }

    const checks =
      body.checks !== undefined
        ? normalizeChecks(body.checks)
        : normalizeChecks(contract?.checks ?? []);
    const comparisons = validateComparisons(body.comparisons);
    const steps = {
      rest: validateRestSteps(body.steps?.rest),
      sql: validateSqlSteps(body.steps?.sql),
    };

    if (checks.length === 0 && comparisons.length === 0) {
      throw new ValidationError(
        'Provide at least one check or comparison — nothing could be verified otherwise',
        { hint: 'checks[] via contract/inline, comparisons[] for cross-system equality' },
      );
    }

    const requirement =
      typeof body.requirement === 'string' && body.requirement.trim()
        ? body.requirement.trim()
        : (contract?.requirement ?? executionView?.requirement ?? null);
    const requirementId =
      typeof body.requirement_id === 'string' && body.requirement_id.trim()
        ? body.requirement_id.trim()
        : (contract?.id ?? null);
    const pageUrl =
      typeof body.url === 'string' && /^https?:\/\//i.test(body.url)
        ? body.url
        : (contract?.url ?? executionView?.url ?? null);

    const result = await runCrossSystemVerification({
      executionId: executionView?.execution_id ?? null,
      requirementId,
      requirement,
      checks,
      comparisons,
      steps,
      connectors: {
        rest: body.connectors?.rest ?? {},
        sql: body.connectors?.sql ?? {},
      },
      record: executionView?.record ?? null,
      pageUrl,
    });

    if (executionView) {
      engine.attachCrossSystem(executionView.execution_id, {
        verification: result.verification,
        evidenceItems: [...result.evidence.api_responses, ...result.evidence.database_results],
      });
    }

    repos?.audit?.record({
      actor: req.get('x-actor') || 'api',
      action: 'cross_system.verified',
      entityType: executionView ? 'execution' : 'contract',
      entityId: executionView?.execution_id ?? contract?.id ?? null,
      details: {
        verdict: result.verification.verdict,
        checks: checks.length,
        comparisons: comparisons.length,
        connector_errors: result.connector_errors.length,
      },
    });

    res.json({
      execution_id: executionView?.execution_id ?? null,
      contract_id: contract?.id ?? null,
      requirement_id: requirementId,
      verification: result.verification,
      systems: result.systems,
      connector_errors: result.connector_errors,
      evidence: result.evidence,
    });
  }));

  /**
   * GET /api/connectors — what the connectors support and which safety
   * controls are in force. Capability description only: never live config,
   * never credentials.
   */
  router.get('/connectors', (_req, res) => {
    res.json({
      rest: {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        safe_methods: ['GET', 'HEAD', 'OPTIONS'],
        mutating_requires_opt_in: true,
        auth_types: ['none', 'bearer', 'basic', 'api_key_header'],
        credential_storage: 'environment variables, referenced by name; values never leave the server',
        controls: [
          'http(s) only',
          'host allowlist (allowed_hosts)',
          'private/loopback targets blocked by default',
          'response size cap',
          'timeouts with bounded retries on safe methods only',
          'sanitized evidence (header names, redacted preview, body hash)',
        ],
      },
      sql: {
        drivers_implemented: ['sqlite'],
        drivers_not_implemented: ['postgres'],
        privileges: 'read-only (driver-level readOnly + PRAGMA query_only)',
        controls: [
          'single statement, SELECT/WITH only',
          'DDL/DML/utility keywords rejected even inside comments/strings',
          'bound parameters required for values',
          'LIMIT enforced + max rows + max cell bytes',
          'hard query timeout via worker termination',
        ],
        note: 'PostgreSQL is an architecture target only and is not implemented or tested.',
      },
    });
  });

  return router;
}
