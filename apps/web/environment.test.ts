import { describe, expect, test } from 'vitest';
import { ConfigurationError, validateEnvironment } from './environment';

describe('server environment', () => {
  test('defaults to a credential-free local configuration', () => {
    expect(validateEnvironment({})).toEqual({ port: 4310 });
    expect(validateEnvironment({ PORT: '4311', AI_ENABLED: 'false', DATABASE_URL: '' })).toEqual({ port: 4311 });
  });

  test('rejects invalid switches and ports instead of silently disabling configured behavior', () => {
    for (const port of ['NaN', '0', '65536', '4310.5']) expect(() => validateEnvironment({ PORT: port })).toThrow(ConfigurationError);
    expect(() => validateEnvironment({ AI_ENABLED: 'yes' })).toThrow('AI_ENABLED must be true or false');
  });

  test('validates database destinations without disclosing credentials', () => {
    expect(() => validateEnvironment({ DATABASE_URL: 'postgresql://owner:private-password@localhost:5432/constellation' })).not.toThrow();
    try { validateEnvironment({ DATABASE_URL: 'https://owner:private-password@localhost/db' }); }
    catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('private-password');
      return;
    }
    throw new Error('Invalid database configuration was accepted.');
  });
});
