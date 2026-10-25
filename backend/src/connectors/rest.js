/**
 * REST API verification connector.
 *
 * Executes a configured HTTP call against a system (order service, CRM,
 * internal API) and returns the response as **evidence** that the independent
 * verification engine can assert against.
 *
 * Security controls built in:
 *  - credentials are *referenced by environment-variable name* and resolved
 *    at call time; neither values nor resolved auth headers ever appear in
 *    the result, the evidence, or logs;
 *  - only http/https URLs, optional host allowlist, and private/loopback
 *    targets blocked by default (SSRF guard — tests opt in via
 *    `allow_private`);
 *  - mutating methods (POST/PUT/PATCH/DELETE) require `allow_mutating: true`;
 *  - response reads are size-capped; retries are limited to safe methods;
 *  - evidence stores header *names*, a redacted body preview, a body hash and
 *    timing — never request credentials.
 */
import crypto from 'node:crypto';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
/** Query-parameter / object-key names that must never keep their value. */
const SENSITIVE_KEY = /(token|secret|password|passwd|api_?key|authorization|credential|signature|private)/i;
/** JSON body fields whose *values* are redacted in evidence previews. */
const SENSITIVE_FIELD =
  /("(?:access_token|refresh_token|id_token|api_?key|authorization|password|secret|client_secret|private_key|token)"\s*:\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi;

const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal']);

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (PRIVATE_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 0 || a === 10 || a === 169 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

function hostAllowed(hostname, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const pattern = String(entry).toLowerCase();
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
    return host === pattern;
  });
}

/** Strip values from sensitive-looking query params before storing a URL. */
export function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return `${url.origin}${url.pathname}${url.search ? `?${url.search.slice(1)}` : ''}`;
  } catch {
    return '<unparseable-url>';
  }
}

/** Redact secret values inside a JSON/text body preview. */
export function sanitizeBody(text) {
  return String(text).replace(SENSITIVE_FIELD, '$1"[REDACTED]"');
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const keep = value.byteLength - (total - maxBytes);
      chunks.push(value.subarray(0, Math.max(keep, 0)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buffer.toString('utf8'), truncated };
}

export class RestConnector {
  /**
   * @param {{
   *   headers?: Record<string,string>,
   *   auth?: { type: 'none'|'bearer'|'basic'|'api_key_header', header?: string, token_env?: string, username_env?: string, password_env?: string },
   *   timeout_ms?: number, max_retries?: number, max_response_bytes?: number,
   *   allow_mutating?: boolean, allowed_hosts?: string[], allow_private?: boolean,
   * }} config
   */
  constructor(config = {}) {
    this.config = config;
    this.timeoutMs = config.timeout_ms ?? 10_000;
    this.maxRetries = config.max_retries ?? 1;
    this.maxResponseBytes = config.max_response_bytes ?? 512_000;
    this.allowMutating = config.allow_mutating ?? false;
    this.allowedHosts = config.allowed_hosts ?? null;
    this.allowPrivate = config.allow_private ?? false;
    this.staticHeaders = config.headers ?? {};
    this.auth = config.auth ?? { type: 'none' };
  }

  /** Non-secret descriptor of the configured auth (safe to expose to a UI). */
  describeAuth() {
    const auth = this.auth ?? { type: 'none' };
    if (!auth.type || auth.type === 'none') return { type: 'none' };
    if (auth.type === 'bearer') return { type: 'bearer', token_env: auth.token_env ?? null };
    if (auth.type === 'api_key_header') return { type: 'api_key_header', header: auth.header ?? null, token_env: auth.token_env ?? null };
    if (auth.type === 'basic') return { type: 'basic', username_env: auth.username_env ?? null, password_env: auth.password_env ?? null };
    return { type: String(auth.type) };
  }

  /** Resolved auth headers — returned only to the fetch call, never stored. */
  #authHeaders() {
    const auth = this.auth ?? { type: 'none' };
    const requireEnv = (name) => {
      const value = (name && process.env[name]) || '';
      if (!value) {
        const err = new Error(`Credential environment variable "${name}" is not set`);
        err.code = 'CONNECTOR_AUTH_FAILED';
        throw err;
      }
      return value;
    };
    switch (auth.type) {
      case 'bearer':
        return { Authorization: `Bearer ${requireEnv(auth.token_env)}` };
      case 'api_key_header':
        return { [auth.header || 'X-API-Key']: requireEnv(auth.token_env) };
      case 'basic':
        return {
          Authorization: `Basic ${Buffer.from(`${requireEnv(auth.username_env)}:${requireEnv(auth.password_env)}`).toString('base64')}`,
        };
      default:
        return {};
    }
  }

  #assertUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      const err = new Error(`"${rawUrl}" is not a valid absolute URL`);
      err.code = 'CONNECTOR_UNAVAILABLE';
      throw err;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const err = new Error(`Refusing scheme ${url.protocol} — only http(s) is allowed`);
      err.code = 'CONNECTOR_UNAVAILABLE';
      throw err;
    }
    if (!hostAllowed(url.hostname, this.allowedHosts)) {
      const err = new Error(`Host ${url.hostname} is not in the connector's allowed_hosts list`);
      err.code = 'CONNECTOR_UNAVAILABLE';
      throw err;
    }
    if (!this.allowPrivate && isPrivateHostname(url.hostname)) {
      const err = new Error(
        `Refusing to call private/loopback host ${url.hostname} (set allow_private for local fixtures)`,
      );
      err.code = 'CONNECTOR_UNAVAILABLE';
      throw err;
    }
    return url;
  }

  /**
   * Execute one configured call.
   * @param {{ key: string, method?: string, url: string, headers?: object, body?: any, timeout_ms?: number, retries?: number }} step
   */
  async run(step) {
    const startedAt = Date.now();
    const method = String(step.method ?? 'GET').toUpperCase();
    const key = step.key;

    const fail = (code, message, extra = {}) => ({
      key,
      ok: false,
      value: null,
      error: { code, message, ...extra },
      evidence: this.#evidence({ method, url: step.url, status: null, durationMs: Date.now() - startedAt, error: code, bodyText: '', truncated: false }),
    });

    try {
      if (!SUPPORTED_METHODS.has(method)) {
        return fail('CONNECTOR_UNAVAILABLE', `Unsupported HTTP method ${method}. Supported: ${[...SUPPORTED_METHODS].join(', ')}`);
      }
      if (MUTATING_METHODS.has(method) && !this.allowMutating) {
        return fail(
          'CONNECTOR_UNAVAILABLE',
          `Method ${method} is mutating and the connector is read-oriented. Set allow_mutating: true to authorize it.`,
        );
      }
      const url = this.#assertUrl(step.url);

      const retries = step.retries ?? this.maxRetries;
      const attempts = SAFE_METHODS.has(method) ? Math.max(1, retries + 1) : 1;
      let lastError = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const timeoutMs = step.timeout_ms ?? this.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const requestHeaders = { Accept: 'application/json', ...this.staticHeaders, ...(step.headers ?? {}) };
        let authHeaderNames = [];
        try {
          Object.assign(requestHeaders, this.#authHeaders());
          authHeaderNames = Object.keys(requestHeaders).filter((name) => SENSITIVE_HEADER.test(name));

          const response = await fetch(url, {
            method,
            headers: requestHeaders,
            body: step.body === undefined || method === 'GET' ? undefined : serializeBody(step.body),
            signal: controller.signal,
            redirect: 'follow',
          });

          const { text, truncated } = await readCapped(response, this.maxResponseBytes);
          const durationMs = Date.now() - startedAt;
          const contentType = response.headers.get('content-type') ?? '';

          const evidence = this.#evidence({
            method,
            url: step.url,
            status: response.status,
            durationMs,
            bodyText: text,
            truncated,
            contentType,
            requestHeaderNames: Object.keys(requestHeaders),
            authHeaderNames,
            attempt: attempt + 1,
          });

          // Safe methods may retry transient upstream failures (5xx/429) —
          // never mutating calls, which could duplicate a side effect.
          const transient = response.status >= 500 || response.status === 429;
          if (transient && SAFE_METHODS.has(method) && attempt + 1 < attempts) {
            lastError = {
              code: 'CONNECTOR_UNAVAILABLE',
              message: `${method} ${sanitizeUrl(step.url)} returned ${response.status}`,
            };
            await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }

          if (response.status === 401 || response.status === 403) {
            return {
              key,
              ok: false,
              value: buildValue(response.status, text, contentType, truncated),
              error: {
                code: 'CONNECTOR_AUTH_FAILED',
                message: `${method} ${sanitizeUrl(step.url)} returned ${response.status} (authentication/authorization failed)`,
              },
              evidence,
            };
          }

          return {
            key,
            ok: response.ok,
            value: buildValue(response.status, text, contentType, truncated),
            error: response.ok ? null : null, // non-2xx is a *result*, not a transport failure
            evidence,
          };
        } catch (err) {
          const timedOut = err?.name === 'AbortError' || controller.signal.aborted;
          lastError = timedOut
            ? { code: 'CONNECTOR_TIMEOUT', message: `${method} ${sanitizeUrl(step.url)} exceeded ${step.timeout_ms ?? this.timeoutMs}ms` }
            : err?.code
              ? { code: err.code, message: err.message }
              : { code: 'CONNECTOR_UNAVAILABLE', message: `Could not reach ${sanitizeUrl(step.url)}: ${err?.message ?? String(err)}` };

          const retryable = timedOut || lastError.code === 'CONNECTOR_UNAVAILABLE';
          if (retryable && attempt + 1 < attempts) {
            await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }
          break;
        } finally {
          clearTimeout(timer);
        }
      }

      return {
        key,
        ok: false,
        value: null,
        error: lastError ?? { code: 'CONNECTOR_UNAVAILABLE', message: 'Request failed' },
        evidence: this.#evidence({
          method,
          url: step.url,
          status: null,
          durationMs: Date.now() - startedAt,
          error: lastError?.code,
          bodyText: '',
          truncated: false,
        }),
      };
    } catch (err) {
      return fail(err?.code ?? 'CONNECTOR_UNAVAILABLE', err?.message ?? String(err));
    }
  }

  /** Sanitized evidence: never contains credentials or auth header values. */
  #evidence({ method, url, status, durationMs, bodyText, truncated, contentType = null, requestHeaderNames = [], authHeaderNames = [], attempt = 1, error = null }) {
    const preview = bodyText ? sanitizeBody(String(bodyText).slice(0, 2_000)) : '';
    return {
      kind: 'api_response',
      source: `rest_connector:${method} ${new URL(safeUrl(url)).pathname}`.slice(0, 200),
      method,
      url: sanitizeUrl(url),
      status: status ?? null,
      content_type: contentType,
      request_header_names: requestHeaderNames.filter((n) => !SENSITIVE_HEADER.test(n)),
      auth_header_names: authHeaderNames,
      body_bytes: bodyText ? Buffer.byteLength(bodyText) : 0,
      body_sha256: bodyText ? crypto.createHash('sha256').update(bodyText).digest('hex') : null,
      body_preview: preview || null,
      truncated: Boolean(truncated),
      attempts: attempt,
      duration_ms: durationMs,
      error,
      captured_at: new Date().toISOString(),
    };
  }
}

function safeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return 'https://invalid.local/';
  }
}

function buildValue(status, text, contentType, truncated) {
  const value = { __http_status: status, __content_type: contentType, __truncated: Boolean(truncated) };
  if (/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(text);
      value.__body = parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(value, parsed);
      else value.__body = parsed;
      return value;
    } catch {
      /* fall through to text */
    }
  }
  value.__body = String(text).slice(0, 200_000);
  return value;
}

function serializeBody(body) {
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}
