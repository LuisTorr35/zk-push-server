import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { Env } from './shared/config/env.schema';
import { configureBodyParsers } from './shared/http/body-parsers';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService<Env, true>);

  configureBodyParsers(app);

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(`zk-push-server listening on port ${port}`);
}

void bootstrap();
