import { Module } from '@nestjs/common';
import { BulkJobsController } from '../controllers/bulk-jobs.controller';
import { BulkJobsRepository } from '../repositories/bulk-jobs.repository';
import { BulkJobsService } from '../services/bulk-jobs.service';
import { StagesModule } from './stages.module';

@Module({
  imports: [StagesModule],
  controllers: [BulkJobsController],
  providers: [BulkJobsService, BulkJobsRepository],
})
export class BulkJobsModule {}
