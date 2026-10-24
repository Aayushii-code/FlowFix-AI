/**
 * Application assembly: config → TinyFish client → verification adapter →
 * execution engine → routes. Kept separate from server.js so tests can build
 * an app against a mock TinyFish base URL without listening on a port.
 */
import express from 'express';
import { loadConfig } from './config.js';
import { TinyFishClient } from './tinyfish/client.js';
import { VerificationAdapter } from './verification/adapter.js';
import { ExecutionEngine } from './execution/engine.js';
import { createRoutes } from './routes/index.js';
import { AppError, errorMiddleware } from './errors.js';

export function createApp(env = process.env) {
  const config = loadConfig(env);

  // The engine needs a client; the client throws without a key. For boot
  // without keys we install a placeholder that fails per-call with a typed
  // error, so /health still answers and POST /executions explains the gap.
  let tinyfish;
  if (config.tinyfish.configured) {
    tinyfish = new TinyFishClient({ apiKey: config.tinyfish.apiKey, baseUrl: config.tinyfish.baseUrl });
  } else {
    tinyfish = {
      runSse: async () => {
        throw new AppError('TINYFISH_NOT_CONFIGURED', 'TINYFISH_API_KEY is not set; executions cannot run', {
          httpStatus: 503,
        });
      },
      getRun: async () => {
        throw new AppError('TINYFISH_NOT_CONFIGURED', 'TINYFISH_API_KEY is not set', { httpStatus: 503 });
      },
      cancelRun: async () => ({ status: 'CANCELLED', message: 'No upstream run to cancel' }),
    };
  }

  const verifier = new VerificationAdapter({
    baseUrl: config.verification.baseUrl,
    timeoutMs: config.verification.timeoutMs,
  });

  const engine = new ExecutionEngine({
    tinyfish,
    verifier,
    timeoutMs: config.execution.timeoutMs,
    maxConcurrent: config.execution.maxConcurrent,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Minimal CORS for Aman's frontend during development.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/api', createRoutes({ engine, config }));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown route', retryable: false } });
  });
  app.use(errorMiddleware);

  return { app, config, engine, verifier };
}
