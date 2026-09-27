import './worker.env'; // must be first: sets the worker's connection pool size before config is read
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { BulkWorkerModule } from './modules/bulk-worker.module';
import { BulkWorkerService } from './services/bulk-worker.service';

/** Second entry point: the background worker, run as its own process so it can be killed and restarted independently. */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(BulkWorkerModule);
  app.enableShutdownHooks();
  app.get(BulkWorkerService).start();
}
bootstrap();
