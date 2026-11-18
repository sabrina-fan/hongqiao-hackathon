import { describe, expect, it } from 'vitest';
import { readServerConfig } from './config.js';

describe('server configuration boundary', () => {
  it.each(['0', '65536', 'abc', '3000oops', ''])('rejects invalid PORT %s', (port) => {
    expect(() => readServerConfig({ PORT: port })).toThrow(/PORT|configuration/);
  });
  it('keeps placeholder credentials disabled and uses secure cookies for HTTPS or production', () => {
    const disabled = readServerConfig({
      AMAP_SERVER_KEY: 'xxxxxxxx',
      COOKIE_SECRET: 'x'.repeat(64),
    });
    expect(disabled.mapKey).toBeNull();
    expect(disabled.cookieSecret).toBeNull();
    expect(readServerConfig({ COOKIE_SECRET: 'short' }).cookieSecret).toBeNull();
    expect(readServerConfig({ PUBLIC_BASE_URL: 'https://example.invalid' }).secureCookie).toBe(
      true,
    );
    expect(readServerConfig({ NODE_ENV: 'production' }).secureCookie).toBe(true);
  });
  it('uses a loopback interface and resolves storage independently of the working directory', () => {
    const config = readServerConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.data_dir).toMatch(/\/data$/);
    expect(config.port).toBe(3000);
  });
});
