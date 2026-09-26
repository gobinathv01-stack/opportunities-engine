import { Module } from '@nestjs/common';
import { StagesRepository } from '../repositories/stages.repository';

@Module({ providers: [StagesRepository], exports: [StagesRepository] })
export class StagesModule {}
