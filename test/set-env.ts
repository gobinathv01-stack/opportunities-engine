import { TEST_DATABASE_URL } from './test-db';

// Runs before each test file loads the app, so config picks up the test database.
process.env.DATABASE_URL = TEST_DATABASE_URL;
