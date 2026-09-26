import { Module } from '@nestjs/common';
import { StagesModule } from './stages.module';
import { TransitionsModule } from './transitions.module';
import { OpportunitiesController } from '../controllers/opportunities.controller';
import { OpportunitiesRepository } from '../repositories/opportunities.repository';
import { OpportunitiesService } from '../services/opportunities.service';

@Module({
  imports: [StagesModule, TransitionsModule],
  controllers: [OpportunitiesController],
  providers: [OpportunitiesService, OpportunitiesRepository],
  exports: [OpportunitiesRepository],
})
export class OpportunitiesModule {}
