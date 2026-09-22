import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { Env } from './shared/config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<Env, true>);

  // ZK terminals send plain text, not JSON, and payloads carry base64
  // photos. The generous limit avoids rejecting a valid BIOPHOTO upload.
  app.useBodyParser('text', { type: () => true, limit: '25mb' });

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(`zk-push-server listening on port ${port}`);
}

void bootstrap();
