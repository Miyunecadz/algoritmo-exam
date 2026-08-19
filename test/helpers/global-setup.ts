import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/billing_test';

/**
 * Migrations run once, against `billing_test`, before any spec. The suite therefore proves the
 * migration chain as well as the code: a schema that only exists on a developer's incrementally
 * built database would fail here.
 */
export default async function globalSetup(): Promise<void> {
  const dataSource = new DataSource(buildDataSourceOptions(TEST_DATABASE_URL));
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
