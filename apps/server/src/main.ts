import { visualExtractionValidator } from '@nextstop/core';
import { configuredRadarModel, configuredVisionExtractor } from '@nextstop/model-gateway';
import { createApp } from './app.js';
import { readServerConfig } from './config.js';

import { createAmap } from './radar/amap.js';
import { readBookingPolicy } from './radar/booking-policy.js';

const config = readServerConfig(process.env);
const server = createApp({
  dataDir: config.data_dir,
  cookieSecret: config.cookieSecret,
  secureCookie: config.secureCookie,
  map: config.mapKey
    ? createAmap({
        key: config.mapKey,
        bookingPolicy: await readBookingPolicy(process.env.RADAR_POLICY_PATH),
      })
    : null,
  radarModel: configuredRadarModel(process.env),
  vision: configuredVisionExtractor(process.env, visualExtractionValidator.check),
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, () => {
    server.off('error', reject);
    resolve();
  });
});
process.stdout.write(
  `${JSON.stringify({ event: 'server_started', host: config.host, port: config.port, radar_configured: Boolean(config.mapKey && config.cookieSecret) })}\n`,
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
