/**
 * Placeholder configuration so modules that read `env` can be imported under
 * test without a real database, Redis, bucket, or API keys.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://clipit:clipit@localhost:5432/clipit_test',
  REDIS_URL: 'redis://localhost:6379',
  AWS_ACCESS_KEY_ID: 'test-access-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  BUCKET_NAME: 'clipit-test',
  OPENROUTER_API_KEY: 'test-openrouter-key',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
