import 'dotenv/config';

const TEST_DATABASE_URL_FALLBACK = 'postgres://postgres:postgres@localhost:5432/billing_test';

/**
 * The suite always runs against the test database, never the development one. Set before any module
 * reads `DATABASE_URL`, so `buildDataSourceOptions()` picks it up. The stub LLM client is forced on
 * as well: no spec may depend on a network call or an API key.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL_FALLBACK;
process.env.LLM_PROVIDER = 'stub';
