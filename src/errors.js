/**
 * Typed errors with stable machine-readable codes. Every error that leaves the
 * service layer carries: code, message, httpStatus, retryable, and optionally
 * the upstream TinyFish error envelope for auditability.
 */

export class AppError extends Error {
  constructor(code, message, { httpStatus = 500, retryable = false, details = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Maps TinyFish API-level error codes (docs.tinyfish.ai/error-codes) to our envelope. */
const TINYFISH_CODE_MAP = {
  MISSING_API_KEY: { httpStatus: 500, retryable: false },
  INVALID_API_KEY: { httpStatus: 502, retryable: false },
  UNAUTHORIZED: { httpStatus: 502, retryable: false },
  VAULT_RECONNECT_REQUIRED: { httpStatus: 502, retryable: false },
  INVALID_INPUT: { httpStatus: 400, retryable: false },
  FORBIDDEN: { httpStatus: 502, retryable: false },
  INSUFFICIENT_CREDITS: { httpStatus: 502, retryable: false },
  FREE_ALLOWANCE_EXHAUSTED: { httpStatus: 502, retryable: true },
  FEATURE_NOT_AVAILABLE: { httpStatus: 502, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  RETRY_REQUIRED: { httpStatus: 502, retryable: true },
  RATE_LIMIT_EXCEEDED: { httpStatus: 502, retryable: true },
};

export class TinyFishApiError extends AppError {
  constructor(upstreamCode, message, { requestId = null, upstreamDetails = null } = {}) {
    const mapped = TINYFISH_CODE_MAP[upstreamCode] || { httpStatus: 502, retryable: true };
    super(`TINYFISH_${upstreamCode || 'UPSTREAM_ERROR'}`, message, {
      httpStatus: mapped.httpStatus,
      retryable: mapped.retryable,
      details: { upstream_code: upstreamCode, ...(requestId ? { request_id: requestId } : {}) },
    });
    this.name = 'TinyFishApiError';
    this.upstream = upstreamDetails; // full upstream error object, kept for audit
  }
}

export class TinyFishNetworkError extends AppError {
  constructor(message, cause = null) {
    super('TINYFISH_NETWORK_ERROR', message, { httpStatus: 502, retryable: true, cause });
    this.name = 'TinyFishNetworkError';
  }
}

export class ExecutionTimeoutError extends AppError {
  constructor(timeoutMs) {
    super('EXECUTION_TIMEOUT', `Execution exceeded the ${timeoutMs}ms watchdog and was cancelled`, {
      httpStatus: 504,
      retryable: true,
      details: { timeout_ms: timeoutMs },
    });
    this.name = 'ExecutionTimeoutError';
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super('NOT_FOUND', message, { httpStatus: 404 });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super('VALIDATION_ERROR', message, { httpStatus: 400, details });
    this.name = 'ValidationError';
  }
}

export class ConcurrencyLimitError extends AppError {
  constructor(limit) {
    super('CONCURRENCY_LIMIT', `Maximum of ${limit} concurrent executions reached; try again shortly`, {
      httpStatus: 429,
      retryable: true,
      details: { limit },
    });
    this.name = 'ConcurrencyLimitError';
  }
}

/** Express error-handling middleware. Maps anything unknown to a 500 envelope. */
export function errorMiddleware(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json(err.toJSON());
  }
  // Express body-parser errors
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', retryable: false },
    });
  }
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', retryable: false },
  });
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
