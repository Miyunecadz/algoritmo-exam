import { MigrationInterface, QueryRunner } from 'typeorm';

/** Fixed UUIDs so the tests and the README's curl walkthrough can reference them literally. */
export const SEED_ORG_A = '11111111-1111-1111-1111-111111111111';
export const SEED_ORG_B = '22222222-2222-2222-2222-222222222222';

export class SeedOrgs1700000000001 implements MigrationInterface {
  name = 'SeedOrgs1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
      [SEED_ORG_A, 'Acme Water District', SEED_ORG_B, 'Northside Power Co-op'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM organizations WHERE id = ANY($1)`, [
      [SEED_ORG_A, SEED_ORG_B],
    ]);
  }
}
