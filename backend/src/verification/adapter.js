/**
 * Integration adapter for Meenu's independent verification engine.
 *
 * Contract (see docs/API.md#verification-engine-contract):
 *   POST {VERIFICATION_ENGINE_URL}/verify
 *   Body: {
 *     execution_id, scenario_id, requirement, url, goal, expected_outcome,
 *     execution_status,          // browser ran to completion — NOT a verdict
 *     observations, evidence,    // normalized facts from the execution
 *   }
 *   Response: {
 *     verdict: "PASS" | "FAIL" | "INCONCLUSIVE",   // required, engine's call
 *     checks: [{ id, description, passed, observed, expected }],
 *     summary: string,
 *   }
 *
 * Guarantees:
 *  - The verdict is whatever the engine says, or null if we could not get it.
 *  - Transport errors / timeouts / malformed responses → status ERROR or
 *    UNAVAILABLE with verdict null. Never PASS-by-default, never FAIL-by-default.
 *  - The engine is assumed independent: it receives raw observations/evidence
 *    and decides. We do not pre-chew its input into a favorable summary.
 */
import { TinyFishNetworkError } from '../errors.js';

const ALLOWED_VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE']);

export class VerificationAdapter {
  /** @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} opts */
  constructor({ baseUrl, timeoutMs = 20_000, fetchImpl = fetch }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return this.baseUrl.length > 0;
  }

  /**
   * Ask the verification engine for an independent verdict.
   * @returns {Promise<{status: string, verdict: 'PASS'|'FAIL'|'INCONCLUSIVE'|null, details: object}>}
   */
  async verify(payload) {
    if (!this.isConfigured()) {
      return {
        status: 'UNAVAILABLE',
        verdict: null,
        details: { reason: 'VERIFICATION_ENGINE_URL is not configured' },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          execution_id: payload.executionId,
          scenario_id: payload.scenarioId,
          requirement: payload.requirement,
          url: payload.url,
          goal: payload.goal,
          expected_outcome: payload.expectedOutcome,
          execution_status: payload.record?.execution_status ?? null,
          observations: payload.record?.observations ?? [],
          evidence: payload.record?.evidence ?? [],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        return {
          status: 'ERROR',
          verdict: null,
          details: {
            reason: `Verification engine did not respond within ${this.timeoutMs}ms`,
            code: 'VERIFICATION_TIMEOUT',
          },
        };
      }
      throw new TinyFishNetworkError(`Could not reach verification engine at ${this.baseUrl}`, err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        status: 'ERROR',
        verdict: null,
        details: {
          reason: `Verification engine responded ${response.status}`,
          code: 'VERIFICATION_ENGINE_ERROR',
          http_status: response.status,
        },
      };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return {
        status: 'ERROR',
        verdict: null,
        details: { reason: 'Verification engine returned non-JSON body', code: 'VERIFICATION_MALFORMED_RESPONSE' },
      };
    }

    if (!body || !ALLOWED_VERDICTS.has(body.verdict)) {
      // A missing or unrecognized verdict can never be coerced into PASS/FAIL.
      return {
        status: 'ERROR',
        verdict: null,
        details: {
          reason: `Verification engine returned an invalid verdict: ${JSON.stringify(body?.verdict ?? null)}. Expected PASS, FAIL, or INCONCLUSIVE.`,
          code: 'VERIFICATION_INVALID_VERDICT',
          raw_response: body ?? null,
        },
      };
    }

    return {
      status: 'COMPLETED',
      verdict: body.verdict,
      details: {
        summary: body.summary ?? null,
        checks: Array.isArray(body.checks) ? body.checks : [],
        engine: this.baseUrl,
        verified_at: new Date().toISOString(),
      },
    };
  }
}
