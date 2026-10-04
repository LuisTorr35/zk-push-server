import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { WebhooksRepository } from './webhooks.repository';
import { WebhookDispatcher } from './webhook-dispatcher.service';
import { WebhookWorker } from './webhook-worker.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [WebhooksRepository, WebhookDispatcher, WebhookWorker],
})
export class WebhookWorkerModule {}
