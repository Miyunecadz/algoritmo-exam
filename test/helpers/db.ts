import { DataSource } from 'typeorm';
import { SEED_ORG_A, SEED_ORG_B } from '../../src/database/migrations/1700000000001-SeedOrgs';

/**
 * Wipes every table and reseeds the two organizations. Called in `beforeEach` so specs cannot
 * depend on each other's rows or on execution order.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE ledger_entries, payments, bills, organizations RESTART IDENTITY CASCADE',
  );
  await dataSource.query(
    'INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)',
    [SEED_ORG_A, 'Acme Water District', SEED_ORG_B, 'Northside Power Co-op'],
  );
}

export async function countRows(dataSource: DataSource, table: string): Promise<number> {
  const [row] = await dataSource.query<{ count: string }[]>(`SELECT count(*)::text FROM ${table}`);
  return Number(row.count);
}
