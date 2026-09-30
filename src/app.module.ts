import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config/config.module';
import { HealthModule } from './modules/health/health.module';
import { IclockModule } from './protocol/iclock/iclock.module';

/**
 * Root module: wiring only. Every feature lives in its own module and gets
 * plugged in here. Once devices, commands, persons, attendance and webhooks
 * exist, they are added to this list and nothing else.
 */
@Module({
  imports: [ConfigModule, HealthModule, IclockModule],
})
export class AppModule {}
