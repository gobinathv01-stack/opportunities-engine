import { Module } from '@nestjs/common';
import { TransitionsRepository } from '../repositories/transitions.repository';

@Module({ providers: [TransitionsRepository], exports: [TransitionsRepository] })
export class TransitionsModule {}
