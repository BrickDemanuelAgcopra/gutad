import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(DB) public readonly db: Db) {}

  async ping(): Promise<boolean> {
    const r = await this.pool.query('select 1 as ok');
    return r.rows[0]?.ok === 1;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    { provide: DB, useFactory: (pool: Pool) => createDb(pool), inject: [PG_POOL] },
    DbService,
  ],
  exports: [DB, PG_POOL, DbService],
})
export class DbModule {}
