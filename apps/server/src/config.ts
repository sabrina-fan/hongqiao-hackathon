import { compile, int, obj, str } from '@earendil-works/pi-schema';
import { resolve } from 'node:path';

const configValidator = compile(
  obj({
    port: int({ minimum: 1, maximum: 65535 }),
    host: str({ minLength: 1 }),
    data_dir: str({ minLength: 1 }),
  }),
);

export function readServerConfig(env: NodeJS.ProcessEnv) {
  const rawPort = env.PORT ?? '3000';
  if (!/^\d+$/.test(rawPort)) throw new Error('PORT must be an integer between 1 and 65535');
  const value = {
    port: Number(rawPort),
    host: env.HOST ?? '127.0.0.1',
    data_dir: resolve(import.meta.dirname, '../../..', env.DATA_DIR ?? 'data'),
  };
  if (!configValidator.check(value)) throw new Error('Invalid server configuration');
  return value;
}
