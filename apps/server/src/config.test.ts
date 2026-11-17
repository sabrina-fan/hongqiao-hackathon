import { describe, expect, it } from 'vitest';
import { readServerConfig } from './config.js';

describe('server configuration boundary', () => {
  it.each(['0', '65536', 'abc', '3000oops', ''])('rejects invalid PORT %s', (port) => {
    expect(() => readServerConfig({ PORT: port })).toThrow(/PORT|configuration/);
  });
  it('uses a loopback interface and resolves storage independently of the working directory', () => {
    const config = readServerConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.data_dir).toMatch(/\/data$/);
    expect(config.port).toBe(3000);
  });
});
