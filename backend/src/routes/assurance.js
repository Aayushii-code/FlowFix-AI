/**
 * Assurance endpoints: the natural-language requirement compiler and
 * e-commerce transaction assurance.
 *
 * The compiler returns a *draft* for human review — it never persists
 * anything. The e-commerce verifier only ever evaluates a sandbox snapshot
 * handed to it; it cannot initiate a purchase.
 */
import { Router } from 'express';
import { asyncRoute, ValidationError } from '../errors.js';
import { compileRequirement } from '../contracts/compiler.js';
import { ECOMMERCE_RULES, verifySandboxTransaction } from '../assurance/ecommerce.js';

export function createAssuranceRoutes() {
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

  return router;
}
