import { Client } from 'pg';
import { connectWhenReady, migrate } from '../src/scripts/migrate';
import { TEST_DATABASE_URL } from './test-db';

/** Once per test run: make sure the test database exists, is migrated, and starts empty. */
export default async function globalSetup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const client = await connectWhenReady(admin.toString());
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
  const log = console.log;
  console.log = () => undefined; // keep test output quiet
  try {
    await migrate(TEST_DATABASE_URL);
  } finally {
    console.log = log;
  }
  const db = new Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query('TRUNCATE transitions, bulk_job_items, bulk_jobs, opportunities, stages, workspaces RESTART IDENTITY CASCADE');
  } finally {
    await db.end();
  }
}
