import { Module } from '@nestjs/common';
import { IclockController } from './iclock.controller';

@Module({
  controllers: [IclockController],
})
export class IclockModule {}
