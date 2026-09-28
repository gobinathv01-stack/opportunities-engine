/** Tests run against their own database so they never touch (or race with a worker on) the dev data. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://opps:opps@localhost:5432/opps_test';
