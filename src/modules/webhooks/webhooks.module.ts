import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ApiKeyGuard } from '../../shared/http/api-key.guard';
import { WebhooksController } from './webhooks.controller';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [WebhooksController],
  providers: [ApiKeyGuard, WebhooksRepository, WebhooksService],
})
export class WebhooksModule {}
