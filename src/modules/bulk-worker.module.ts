import { Module } from '@nestjs/common';
import { BulkWorkerRepository } from '../repositories/bulk-worker.repository';
import { BulkWorkerService } from '../services/bulk-worker.service';
import { DatabaseModule } from './database.module';
import { StagesModule } from './stages.module';

/** The worker process: no HTTP, just the job runner. */
@Module({ imports: [DatabaseModule, StagesModule], providers: [BulkWorkerService, BulkWorkerRepository], exports: [BulkWorkerService] })
export class BulkWorkerModule {}
