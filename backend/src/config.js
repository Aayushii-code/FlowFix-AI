/**
 * Central configuration. Reads process.env once at startup, validates what it
 * can, and never throws on missing optional values — the API must boot even
 * without keys so it can explain what is missing instead of crashing.
 */
const DEFAULTS = {
  PORT: 3000,
  TINYFISH_BASE_URL: 'https://agent.tinyfish.ai',
  EXECUTION_TIMEOUT_MS: 300_000, // our watchdog; independent of TinyFish's own limit
  MAX_CONCURRENT_EXECUTIONS: 3,
  VERIFICATION_TIMEOUT_MS: 20_000,
};

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const config = {
    port: intOr(env.PORT, DEFAULTS.PORT),
    tinyfish: {
      apiKey: (env.TINYFISH_API_KEY || '').trim(),
      baseUrl: (env.TINYFISH_BASE_URL || DEFAULTS.TINYFISH_BASE_URL).replace(/\/+$/, ''),
    },
    execution: {
      timeoutMs: intOr(env.EXECUTION_TIMEOUT_MS, DEFAULTS.EXECUTION_TIMEOUT_MS),
      maxConcurrent: intOr(env.MAX_CONCURRENT_EXECUTIONS, DEFAULTS.MAX_CONCURRENT_EXECUTIONS),
    },
    verification: {
      baseUrl: (env.VERIFICATION_ENGINE_URL || '').trim().replace(/\/+$/, ''),
      timeoutMs: intOr(env.VERIFICATION_TIMEOUT_MS, DEFAULTS.VERIFICATION_TIMEOUT_MS),
    },
  };

  config.tinyfish.configured = config.tinyfish.apiKey.length > 0;
  config.verification.configured = config.verification.baseUrl.length > 0;

  return Object.freeze(config);
}
