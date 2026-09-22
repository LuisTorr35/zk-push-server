import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Global configuration: any module can inject ConfigService without importing
 * anything else. This is the single entry point to process.env; the rest of the
 * codebase never reads it directly, which keeps everything testable with
 * different values.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
