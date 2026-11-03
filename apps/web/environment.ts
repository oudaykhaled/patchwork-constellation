/** Validate server settings without ever including their values in diagnostics. */
export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration needs attention: ${problems.join(' ')}`);
    this.name = 'ConfigurationError';
  }
}

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const problems: string[] = [];
  const port = env.PORT === undefined || env.PORT === '' ? 4310 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be an integer from 1 to 65535.');
  if (env.AI_ENABLED && !['true', 'false'].includes(env.AI_ENABLED)) problems.push('AI_ENABLED must be true or false.');
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    } catch { problems.push('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
  }
  if (problems.length) throw new ConfigurationError(problems);
  return { port };
}
