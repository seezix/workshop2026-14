import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ENV, type Env, loadEnv } from '../config/env.js';
import * as schema from './schema.js';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export type Database = NodePgDatabase<typeof schema>;

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) => {
        const pool = new pg.Pool({
          connectionString: env.DATABASE_URL,
          max: 10,
        });
        const logger = new Logger('Postgres');
        pool.on('error', (err) =>
          logger.error(`Connexion du pool perdue : ${err.message}`),
        );
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database =>
        drizzle({ client: pool, schema }),
    },
    PoolCloser,
  ],
  exports: [ENV, PG_POOL, DB],
})
export class DatabaseModule {}
