import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * Money is stored as `numeric(12,2)` and travels as a string end to end.
 *
 * `node-postgres` returns `numeric` as a JavaScript string by default, which is exactly what we
 * want: an IEEE-754 double cannot represent `0.10`, so parsing money into a `number` — even once,
 * even only for a comparison — silently loses cents. We therefore deliberately DO NOT register a
 * `pg` type parser for OID 1700 (`numeric`) anywhere in this codebase. If you are tempted to add
 * one, don't: every aggregation and every comparison in this project happens in SQL.
 */

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/billing';

export function buildDataSourceOptions(url?: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    // Non-negotiable: the schema is owned by migrations, never by entity synchronisation.
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === 'true',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    // The concurrency tests are meaningless against a size-1 pool: two "simultaneous" requests
    // would simply queue on the single connection and never actually race.
    extra: { max: 10 },
  };
}

/** Used by both the running application and the TypeORM CLI (`migration:run`). */
export default new DataSource(buildDataSourceOptions());
