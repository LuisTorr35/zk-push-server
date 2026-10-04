import { NestFactory } from '@nestjs/core';
import { WebhookWorkerModule } from './modules/webhooks/webhook-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WebhookWorkerModule);
  app.enableShutdownHooks();
}
void bootstrap();
