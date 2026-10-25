/**
 * Platform metadata + audit endpoints.
 *
 * Everything a UI needs to render the assurance model without hardcoding it:
 * the reason-code catalog (why a run failed / was inconclusive), the operator
 * catalog (what checks can express) and the append-only audit trail.
 */
import { Router } from 'express';
import { asyncRoute } from '../errors.js';
import { REASON_CODES, describeReasons } from '../verification/reasons.js';
import { OPERATOR_NAMES } from '../checks/operators.js';
import { CHECK_SOURCES } from '../checks/validate.js';
import { LOCAL_ENGINE_ID } from '../verification/local-engine.js';

export function createSystemRoutes({ repos, config }) {
  const router = Router();

  /** Audit trail — who did what, when, with what details. Append-only. */
  router.get('/audit', (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const { entries, total } = repos.audit.list({
      action: typeof req.query.action === 'string' ? req.query.action : null,
      entity_type: typeof req.query.entity_type === 'string' ? req.query.entity_type : null,
      entity_id: typeof req.query.entity_id === 'string' ? req.query.entity_id : null,
      actor: typeof req.query.actor === 'string' ? req.query.actor : null,
      limit,
      offset,
    });
    res.json({ entries, total, limit, offset });
  });

  /** Reason codes the UI can render as explanations. */
  router.get('/reason-codes', (_req, res) => {
    res.json({
      reason_codes: Object.entries(REASON_CODES).map(([code, meta]) => ({ code, ...meta })),
    });
  });

  /** Operator + source catalog for the contract compiler UI. */
  router.get('/check-types', (_req, res) => {
    res.json({
      operators: OPERATOR_NAMES,
      sources: CHECK_SOURCES.map((source) => ({
        source,
        independent: ['page', 'api', 'database', 'sandbox'].includes(source),
        note:
          source === 'agent_report'
            ? 'The agent\u2019s own output — context only, can never produce PASS or FAIL.'
            : ['page', 'api', 'database', 'sandbox'].includes(source)
              ? 'Queried by FlowFix itself, independently of the automation agent.'
              : 'Normalized observation; not independent proof.',
      })),
      severities: ['low', 'medium', 'high', 'critical'],
      verification_engines: {
        external_configured: config.verification.configured,
        local_enabled: config.verification.localEnabled,
        local_engine: LOCAL_ENGINE_ID,
      },
    });
  });

  /** Which capabilities are actually configured (never claim the unknown). */
  router.get('/capabilities', asyncRoute(async (_req, res) => {
    res.json({
      tinyfish: { configured: config.tinyfish.configured },
      verification: {
        external_configured: config.verification.configured,
        local_enabled: config.verification.localEnabled,
        engine: config.verification.configured ? 'external' : config.verification.localEnabled ? 'local' : 'none',
      },
      persistence: { path: config.database.path, kind: 'sqlite' },
      queue: { driver: 'in-process', redis_ready: true },
      connectors: {
        rest: 'available',
        sql: 'available',
        email: 'not_configured',
        crm: 'not_configured',
        erp: 'not_configured',
      },
    });
  }));

  return router;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
