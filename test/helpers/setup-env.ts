import 'dotenv/config';

/**
 * The suite always runs against the test database, never the development one. Set before any
 * module reads `DATABASE_URL`, so `buildDataSourceOptions()` picks it up.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL_FALLBACK();
process.env.LLM_PROVIDER = 'stub';

function TEST_DATABASE_URL_FALLBACK(): string {
  return 'postgres://postgres:postgres@localhost:5432/billing_test';
}
