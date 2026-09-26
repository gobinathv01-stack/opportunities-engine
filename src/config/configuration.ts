/** The only place that reads environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '', 
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
};
