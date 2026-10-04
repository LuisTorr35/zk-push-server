import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config/config.module';
import { HealthModule } from './modules/health/health.module';
import { IclockModule } from './protocol/iclock/iclock.module';
import { PersonsModule } from './modules/persons/persons.module';

/** Root module: wiring only. Each feature is assembled through its own module. */
@Module({
  imports: [WebhooksModule, ConfigModule, HealthModule, IclockModule, PersonsModule],
})
export class AppModule {}
