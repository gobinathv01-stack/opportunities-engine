import { Client } from 'pg';
import { config } from '../config/configuration';

/** Deletes all data (keeps the schema) so a seed starts from a clean database. Dev only. */
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset a production database');
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('TRUNCATE transitions, opportunities, stages, workspaces RESTART IDENTITY CASCADE');
    console.log('all data cleared');
  } finally {
    await client.end();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
