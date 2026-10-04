import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { OutboxWriter } from './outbox.writer';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [OutboxWriter],
  exports: [OutboxWriter],
})
export class OutboxModule {}
