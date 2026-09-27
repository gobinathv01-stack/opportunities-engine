// Imported first by worker.main.ts: gives the worker its own small pool so bulk work can't starve the API's.
process.env.DB_POOL_MAX ??= '4';
