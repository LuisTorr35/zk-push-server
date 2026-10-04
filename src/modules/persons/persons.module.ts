import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { StorageModule } from '../../shared/storage/storage.module';
import { ApiKeyGuard } from '../../shared/http/api-key.guard';
import { PersonPinPipe } from './persons-http.validation';
import { PersonsController } from './persons.controller';
import { PersonsRepository } from './persons.repository';
import { PersonsService } from './persons.service';

@Module({
  imports: [ConfigModule, PrismaModule, StorageModule],
  controllers: [PersonsController],
  providers: [PersonsService, PersonsRepository, ApiKeyGuard, PersonPinPipe],
  exports: [PersonsService],
})
export class PersonsModule {}
