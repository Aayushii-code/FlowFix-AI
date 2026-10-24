/**
 * Server entry point. Boots the Express app, logs configuration state
 * (never secrets), and shuts down gracefully.
 */
import 'dotenv/config';
import { createApp } from './app.js';

const { app, config } = createApp();

const server = app.listen(config.port, () => {
  console.log(`[flowfix] backend listening on :${config.port}`);
  console.log(`[flowfix] TinyFish configured: ${config.tinyfish.configured ? 'yes' : 'NO (executions will fail with TINYFISH_NOT_CONFIGURED)'}`);
  console.log(
    `[flowfix] Verification engine: ${
      config.verification.configured
        ? `external (${config.verification.baseUrl})`
        : config.verification.localEnabled
          ? 'local (FlowFix independent verifier — checks only)'
          : 'disabled (verdicts stay null until configured)'
    }`,
  );
  console.log(`[flowfix] Database: ${config.database.path}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[flowfix] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
