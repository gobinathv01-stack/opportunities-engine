import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { sleep } from '../common/utils';
import { config } from '../config/configuration';

const NOT_READY = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', '57P03']);
const notReady = (err: any): boolean =>
  NOT_READY.has(err?.code) || (Array.isArray(err?.errors) && err.errors.some((e: any) => NOT_READY.has(e?.code)));

/** Connects, waiting for the database to come up (containers start in no guaranteed order or readiness). */
export async function connectWhenReady(databaseUrl: string, timeoutMs = 60_000): Promise<Client> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (true) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (!notReady(err) || Date.now() > deadline) throw err;
      if (!announced) console.log('waiting for the database to accept connections...');
      announced = true;
      await sleep(1_000);
    }
  }
}

/** Applies migrations/*.sql in filename order, once each. */
export async function migrate(databaseUrl: string = config.databaseUrl, dir: string = join(process.cwd(), 'migrations')) {
  const client = await connectWhenReady(databaseUrl);
  try {
    await client.query('SELECT pg_advisory_lock(727274)'); // one migrator at a time; released when the session ends
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
