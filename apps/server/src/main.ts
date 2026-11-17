import { createApp } from './app.js';
import { readServerConfig } from './config.js';

const config = readServerConfig(process.env);
const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, () => {
    server.off('error', reject);
    resolve();
  });
});
process.stdout.write(
  `${JSON.stringify({ event: 'server_started', host: config.host, port: config.port, stage: 'scaffold' })}\n`,
);

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error(JSON.stringify({ event: 'shutdown_failed' }));
      process.exitCode = 1;
    }
  });
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
