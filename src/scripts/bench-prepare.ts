import { execFileSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';
import { config } from '../config/configuration';
import { migrate } from './migrate';

/** Recreates the benchmark database (named by DATABASE_URL) from scratch: schema + the large seed. */
async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set, e.g. export DATABASE_URL=postgres://opps:opps@localhost:5432/opps_bench');
  const target = new URL(config.databaseUrl);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`refusing odd database name "${dbName}"`);
  if (!dbName.includes('bench')) throw new Error(`refusing to drop "${dbName}": the benchmark database name must contain "bench" (e.g. opps_bench)`);
  const admin = new URL(config.databaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
  await migrate(config.databaseUrl);
  execFileSync('node', [join(__dirname, 'seed-large.js')], { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  console.log(`benchmark database "${dbName}" is ready`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
