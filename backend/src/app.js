/**
 * Application assembly: config → database → TinyFish client → verification →
 * queue → execution engine → routes → dashboard. Kept separate from
 * server.js so tests can build an app against a mock TinyFish base URL
 * without listening on a port.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createContractRepository } from './db/repos/contracts.js';
import { createExecutionRepository } from './db/repos/executions.js';
import { createAuditRepository } from './db/repos/audit.js';
import { createJobQueue } from './queue/index.js';
import { TinyFishClient } from './tinyfish/client.js';
import { VerificationAdapter } from './verification/adapter.js';
import { ExecutionEngine } from './execution/engine.js';
import { createRoutes } from './routes/index.js';
import { createContractRoutes } from './routes/contracts.js';
import { createSystemRoutes } from './routes/system.js';
import { createAssuranceRoutes } from './routes/assurance.js';
import { AppError, errorMiddleware } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(env = process.env) {
  const config = loadConfig(env);

  // Durable store first: contracts, run history and audit log live in SQLite
  // (DATABASE_PATH), never only in memory.
  const database = openDatabase({ path: config.database.path });
  const repos = {
    contracts: createContractRepository(database.db),
    executions: createExecutionRepository(database.db),
    audit: createAuditRepository(database.db),
  };
  const queue = createJobQueue({ concurrency: config.execution.maxConcurrent });

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
    persistence: repos.executions,
    audit: repos.audit,
    queue,
    localVerification: config.verification.localEnabled,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // CORS for Aman's frontend during development. Defaults to the permissive
  // dev behaviour; set CORS_ORIGINS=https://app.example.com to pin an
  // allowlist (required before this port is exposed outside localhost).
  const allowedOrigins = config.corsOrigins;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowAll = allowedOrigins.length === 0;
    if (allowAll) res.set('Access-Control-Allow-Origin', '*');
    else if (origin && allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/api', createContractRoutes({ repos, engine, config }));
  app.use('/api', createSystemRoutes({ repos, config }));
  app.use('/api', createAssuranceRoutes({ engine, repos }));
  app.use('/api', createRoutes({ engine, config, repos, queue, verifier }));

  // Enterprise dashboard (vanilla, no build step) — real APIs only.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown route', retryable: false } });
  });
  app.use(errorMiddleware);

  return {
    app,
    config,
    engine,
    verifier,
    db: database,
    repos,
    queue,
    async close() {
      await queue.close();
      database.close();
    },
  };
}
