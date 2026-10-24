/**
 * Real TinyFish Agent API client (docs.tinyfish.ai).
 *
 * Speaks directly to the canonical endpoints:
 *   POST {base}/v1/automation/run-sse   — SSE automation stream (primary path)
 *   GET  {base}/v1/runs/:id             — run object incl. steps + screenshots
 *   POST {base}/v1/runs/:id/cancel      — idempotent cancellation
 *
 * Auth: X-API-Key header. Responses are parsed per the documented SSE event
 * types (STARTED, STREAMING_URL, PROGRESS, HEARTBEAT, COMPLETE) and the
 * documented error envelope ({ error: { code, message, details }, request_id }).
 *
 * Nothing here fabricates data: a missing COMPLETE event is an error, an
 * upstream error body is preserved verbatim on the thrown TinyFishApiError.
 */
import { SseParser } from './sse.js';
import { AppError, TinyFishApiError, TinyFishNetworkError, ValidationError } from '../errors.js';

const SSE_EVENT_TYPES = new Set(['STARTED', 'STREAMING_URL', 'PROGRESS', 'HEARTBEAT', 'COMPLETE']);

/**
 * Timeout for the post-run evidence lookup (GET /v1/runs/:id).
 * The execution watchdog is already disarmed by the time this fetch runs, so
 * without its own deadline a stalled lookup would pin the execution in
 * RUNNING indefinitely and hold a concurrency slot.
 */
export const RUN_LOOKUP_TIMEOUT_MS = 15_000;

export class TinyFishClient {
  /**
   * @param {{ apiKey: string, baseUrl: string, fetchImpl?: typeof fetch }} opts
   */
  constructor({ apiKey, baseUrl, fetchImpl = fetch }) {
    if (!apiKey) {
      throw new ValidationError('TINYFISH_API_KEY is not configured');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    return {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async raiseForStatus(response) {
    if (response.ok) return;
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON error body */
    }
    const code = body?.error?.code || 'UPSTREAM_ERROR';
    const message = body?.error?.message || `TinyFish responded ${response.status}`;
    throw new TinyFishApiError(code, message, {
      requestId: body?.request_id || response.headers?.get?.('x-request-id') || null,
      upstreamDetails: body?.error ?? null,
    });
  }

  /**
   * Build the documented request body. Only known TinyFish fields are sent.
   * @param {{ url: string, goal: string, browserProfile?: 'lite'|'stealth',
   *           agentConfig?: object, captureConfig?: object, outputSchema?: object }} params
   */
  buildRunPayload({ url, goal, browserProfile, agentConfig, captureConfig, outputSchema }) {
    const payload = { url, goal };
    if (browserProfile) payload.browser_profile = browserProfile;
    if (agentConfig && Object.keys(agentConfig).length > 0) payload.agent_config = agentConfig;
    if (captureConfig && Object.keys(captureConfig).length > 0) payload.capture_config = captureConfig;
    if (outputSchema) payload.output_schema = outputSchema;
    return payload;
  }

  /**
   * Run an automation over SSE and stream parsed events to callbacks.
   *
   * Resolves with the COMPLETE event payload once received. Rejects with:
   *  - TinyFishApiError for documented API errors (auth, validation, billing…)
   *  - TinyFishNetworkError for transport failures / truncated streams
   *
   * @param {object} params        see buildRunPayload
   * @param {{ onEvent?: (evt: object) => void, signal?: AbortSignal }} opts
   */
  async runSse(params, { onEvent, signal } = {}) {
    const payload = this.buildRunPayload(params);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/automation/run-sse`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // propagate cancellation untouched
      throw new TinyFishNetworkError(`Could not reach TinyFish at ${this.baseUrl}`, err);
    }

    await this.raiseForStatus(response);

    if (!response.body) {
      throw new TinyFishNetworkError('TinyFish returned a stream with no body');
    }

    const parser = new SseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let complete = null;

    const dispatch = (parsed) => {
      // Normalize: TinyFish emits one JSON object per data line.
      const event = parsed.json !== undefined ? parsed.json : { type: parsed.event, raw: parsed.data };
      if (event.type && !SSE_EVENT_TYPES.has(event.type)) {
        event.unknown_type = true; // forward-compatible: keep but flag
      }
      onEvent?.(event);
      if (event.type === 'COMPLETE') complete = event;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const parsed of parser.push(decoder.decode(value, { stream: true }))) {
          dispatch(parsed);
        }
      }
      for (const parsed of parser.flush()) dispatch(parsed);
    } catch (err) {
      // Release the HTTP connection on abort/error. Without this, an aborted
      // stream can leave the socket half-open (the upstream keeps writing to
      // a connection nobody reads) — a zombie run after every timeout/cancel.
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
      if (err?.name === 'AbortError') throw err;
      throw new TinyFishNetworkError('TinyFish SSE stream failed mid-flight', err);
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }

    if (!complete) {
      throw new TinyFishNetworkError('TinyFish stream ended without a COMPLETE event');
    }
    return complete;
  }

  /**
   * Fetch the documented run object (status, result, steps, screenshots).
   * @param {string} runId
   * @param {{ screenshots?: 'url'|'base64'|'none' }} opts
   */
  async getRun(runId, { screenshots = 'url', timeoutMs = RUN_LOOKUP_TIMEOUT_MS } = {}) {
    const url = `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}?screenshots=${screenshots}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new AppError('TINYFISH_TIMEOUT', `TinyFish run lookup timed out after ${timeoutMs}ms`, {
          httpStatus: 504,
          retryable: true,
          details: { timeout_ms: timeoutMs, run_id: runId },
        });
      }
      throw new TinyFishNetworkError(`Could not reach TinyFish at ${this.baseUrl}`, err);
    } finally {
      clearTimeout(timer);
    }
    await this.raiseForStatus(response);
    return response.json();
  }

  /**
   * Cancel a PENDING/RUNNING run. Idempotent on TinyFish's side; returns the
   * current run state ({ status, cancelled_at, message }). Never throws on
   * "already finished" — callers use this during timeout cleanup.
   */
  async cancelRun(runId) {
    const url = `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`;
    let response;
    try {
      response = await this.fetch(url, { method: 'POST', headers: this.headers() });
    } catch (err) {
      throw new TinyFishNetworkError(`Could not reach TinyFish at ${this.baseUrl}`, err);
    }
    await this.raiseForStatus(response);
    return response.json();
  }
}
