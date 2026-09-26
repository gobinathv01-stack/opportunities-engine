import { Module } from '@nestjs/common';
import { DatabaseModule } from './modules/database.module';
import { OpportunitiesModule } from './modules/opportunities.module';
import { StagesModule } from './modules/stages.module';
import { TransitionsModule } from './modules/transitions.module';

@Module({ imports: [DatabaseModule, StagesModule, TransitionsModule, OpportunitiesModule] })
export class AppModule {}
