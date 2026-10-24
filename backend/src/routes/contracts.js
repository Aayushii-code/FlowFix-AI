/**
 * Contract Library API — create, review, revise, reuse and execute business
 * verification contracts.
 *
 * A contract is the unit of assurance: a plain-language requirement plus the
 * machine-verifiable `checks` that prove it, the workflow steps, evidence
 * requirements and a risk level. Contracts are stored in SQLite with a full
 * revision history, so "what did we promise, and when did it change" is
 * always answerable.
 *
 * Every mutation is written to the audit log.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { asyncRoute, NotFoundError, ValidationError, AppError } from '../errors.js';
import { normalizeChecks } from '../checks/validate.js';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const CONTRACT_SOURCES = new Set(['manual', 'nl_compiler', 'scenario', 'import']);

function requireString(value, field, { max = 20_000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  if (value.length > max) throw new ValidationError(`${field} is too long (max ${max} characters)`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return value.trim() || null;
}

function optionalUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new ValidationError('url must be an absolute http(s) URL');
  }
  return value;
}

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  return value.map((item, i) => {
    if (typeof item === 'string') {
      if (!item.trim()) throw new ValidationError(`${field}[${i}] must not be empty`);
      return { text: item.trim() };
    }
    if (item && typeof item === 'object') return item;
    throw new ValidationError(`${field}[${i}] must be a string or an object`);
  });
}

/**
 * Validate a contract payload. `partial` supports PATCH-style updates where
 * absent fields keep their current value.
 */
function validateContract(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const out = {};

  if (!partial || body.name !== undefined) out.name = requireString(body.name, 'name', { max: 200 });
  if (!partial || body.requirement !== undefined) {
    out.requirement = requireString(body.requirement, 'requirement');
  }
  if (body.description !== undefined) out.description = optionalString(body.description, 'description');
  if (body.url !== undefined) out.url = optionalUrl(body.url);
  if (body.goal !== undefined) out.goal = optionalString(body.goal, 'goal');
  if (body.checks !== undefined) out.checks = normalizeChecks(body.checks);
  if (body.risk_level !== undefined) {
    if (!RISK_LEVELS.has(body.risk_level)) {
      throw new ValidationError(`risk_level must be one of: ${[...RISK_LEVELS].join(', ')}`);
    }
    out.risk_level = body.risk_level;
  }
  if (body.source !== undefined) {
    if (!CONTRACT_SOURCES.has(body.source)) {
      throw new ValidationError(`source must be one of: ${[...CONTRACT_SOURCES].join(', ')}`);
    }
    out.source = body.source;
  }
  if (body.expected_outcome !== undefined) {
    if (body.expected_outcome !== null && typeof body.expected_outcome !== 'object') {
      throw new ValidationError('expected_outcome must be an object or null');
    }
    out.expected_outcome = body.expected_outcome ?? null;
  }
  if (body.preconditions !== undefined) out.preconditions = stringList(body.preconditions, 'preconditions');
  if (body.steps !== undefined) out.steps = stringList(body.steps, 'steps');
  if (body.expected_results !== undefined) {
    out.expected_results = stringList(body.expected_results, 'expected_results');
  }
  if (body.evidence_requirements !== undefined) {
    out.evidence_requirements = stringList(body.evidence_requirements, 'evidence_requirements');
  }

  if (!partial) {
    // A contract that cannot be executed or verified is a document, not an
    // assurance contract: require at least a requirement and one check.
    if (!out.checks || out.checks.length === 0) {
      throw new ValidationError(
        'A contract needs at least one check — without machine-verifiable checks no verdict can ever be produced',
        { hint: 'checks: [{ key, operator, expected, source? }]' },
      );
    }
  } else if (out.checks !== undefined && out.checks.length === 0) {
    throw new ValidationError('checks must contain at least one check (clearing them would make the contract unverifiable)');
  }

  return out;
}

export function createContractRoutes({ repos, engine }) {
  const router = Router();
  const audit = (entry) => repos.audit.record(entry);

  // ── Create ───────────────────────────────────────────────────────────────
  router.post('/contracts', asyncRoute((req, res) => {
    const data = validateContract(req.body);
    const now = new Date().toISOString();
    const contract = repos.contracts.insert({
      id: crypto.randomUUID(),
      name: data.name,
      description: data.description ?? null,
      requirement: data.requirement,
      url: data.url ?? null,
      goal: data.goal ?? null,
      checks: data.checks ?? [],
      preconditions: data.preconditions ?? [],
      steps: data.steps ?? [],
      expected_results: data.expected_results ?? [],
      evidence_requirements: data.evidence_requirements ?? [],
      expected_outcome: data.expected_outcome ?? null,
      risk_level: data.risk_level ?? 'medium',
      status: 'active',
      version: 1,
      source: data.source ?? 'manual',
      created_at: now,
      updated_at: now,
    });
    audit({
      actor: req.get('x-actor') || 'api',
      action: 'contract.created',
      entityType: 'contract',
      entityId: contract.id,
      details: { name: contract.name, risk_level: contract.risk_level, checks: contract.checks.length },
    });
    res.status(201).json({ contract });
  }));

  // ── List / search ────────────────────────────────────────────────────────
  router.get('/contracts', (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const { contracts, total } = repos.contracts.list({
      q: typeof req.query.q === 'string' ? req.query.q : '',
      status: typeof req.query.status === 'string' ? req.query.status : 'active',
      risk_level: typeof req.query.risk_level === 'string' ? req.query.risk_level : null,
      limit,
      offset,
    });
    res.json({ contracts, total, limit, offset });
  });

  // ── Read ─────────────────────────────────────────────────────────────────
  router.get('/contracts/:id', (req, res) => {
    const contract = repos.contracts.get(req.params.id);
    if (!contract) throw new NotFoundError(`Contract ${req.params.id} not found`);
    res.json({ contract });
  });

  router.get('/contracts/:id/revisions', (req, res) => {
    const contract = repos.contracts.get(req.params.id);
    if (!contract) throw new NotFoundError(`Contract ${req.params.id} not found`);
    res.json({ contract_id: contract.id, version: contract.version, revisions: repos.contracts.listRevisions(contract.id) });
  });

  // ── Update (bumps version, keeps the previous snapshot) ──────────────────
  router.put('/contracts/:id', asyncRoute((req, res) => {
    const existing = repos.contracts.get(req.params.id);
    if (!existing) throw new NotFoundError(`Contract ${req.params.id} not found`);

    const patch = validateContract(req.body, { partial: true });
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Provide at least one field to update');
    }

    const contract = repos.contracts.update(existing.id, patch, {
      changeNote: typeof req.body?.change_note === 'string' ? req.body.change_note : null,
    });
    audit({
      actor: req.get('x-actor') || 'api',
      action: 'contract.updated',
      entityType: 'contract',
      entityId: contract.id,
      details: {
        fields: Object.keys(patch),
        version: contract.version,
        previous_version: existing.version,
        change_note: req.body?.change_note ?? null,
      },
    });
    res.json({ contract });
  }));

  // ── Archive (soft delete keeps the audit trail intact) ───────────────────
  router.delete('/contracts/:id', (req, res) => {
    const existing = repos.contracts.get(req.params.id);
    if (!existing) throw new NotFoundError(`Contract ${req.params.id} not found`);
    const contract = repos.contracts.update(existing.id, { status: 'archived' }, { changeNote: 'archived' });
    audit({
      actor: req.get('x-actor') || 'api',
      action: 'contract.archived',
      entityType: 'contract',
      entityId: contract.id,
      details: { name: contract.name },
    });
    res.json({ contract_id: contract.id, status: contract.status });
  });

  // ── Execute a contract ───────────────────────────────────────────────────
  router.post('/contracts/:id/executions', asyncRoute((req, res) => {
    const contract = repos.contracts.get(req.params.id);
    if (!contract) throw new NotFoundError(`Contract ${req.params.id} not found`);
    if (contract.status !== 'active') {
      throw new AppError('CONTRACT_ARCHIVED', `Contract ${contract.id} is archived and cannot be executed`, {
        httpStatus: 409,
      });
    }
    if (!contract.url || !contract.goal) {
      throw new AppError(
        'CONTRACT_NOT_EXECUTABLE',
        'This contract has no url/goal to drive a browser journey with. Add them before executing.',
        { httpStatus: 422, details: { contract_id: contract.id } },
      );
    }

    const body = req.body ?? {};
    const spec = {
      contractId: contract.id,
      scenarioId: null,
      requirement: contract.requirement,
      url: contract.url,
      goal: contract.goal,
      expectedOutcome: contract.expected_outcome ?? null,
      checks: contract.checks ?? [],
      browserProfile: body.browser_profile ?? undefined,
      agentConfig: body.agent_config ?? undefined,
      captureConfig: body.capture_config ?? undefined,
    };
    if (body.execution_timeout_ms !== undefined) {
      const t = Number(body.execution_timeout_ms);
      if (!Number.isFinite(t) || t <= 0) throw new ValidationError('execution_timeout_ms must be a positive number');
      spec.executionTimeoutMs = t;
    }

    const execution = engine.createExecution(spec);
    audit({
      actor: req.get('x-actor') || 'api',
      action: 'contract.executed',
      entityType: 'contract',
      entityId: contract.id,
      details: { execution_id: execution.execution_id, contract_version: contract.version },
    });
    res.status(202).json(execution);
  }));

  return router;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
