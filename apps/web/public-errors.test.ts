import { expect, test } from 'vitest';
import { publicErrorCode, publicErrorMessage, PRODUCTION_CONTENT_SECURITY_POLICY } from './public-errors';

test('public diagnostics never serialize raw exceptions, unknown codes, sources or credentials', () => {
  const privateText = 'PRIVATE_SOURCE_SENTINEL postgres://user:password@private-host/db github_pat_AAAAAAAAAAAAAAAAAAAAAAAA Bearer eyJhbGciOiJSUzI1NiJ9.private.signature';
  for (const error of [new Error(privateText), Object.assign(new Error(privateText), { status: 400 }), Object.assign(new Error(privateText), { code: privateText }), Object.assign(new Error(privateText), { code: 'STALE_SOURCE' })]) {
    const serialized = JSON.stringify({ error: publicErrorMessage(error), code: publicErrorCode(error) });
    expect(serialized).not.toMatch(/PRIVATE_SOURCE|postgres:|github_pat_|Bearer|private-host|eyJhb/);
  }
  expect(publicErrorCode({ code: '__proto__' })).toBe('REQUEST_FAILED');
  expect(publicErrorMessage({ code: 'STALE_SOURCE' })).toContain('Refresh');
  expect(publicErrorMessage({ name: 'ZodError', message: privateText })).not.toContain(privateText);
});

test('production policy confines executable content and connections while permitting graph workers', () => {
  expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("worker-src 'self' blob:");
  expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
});
