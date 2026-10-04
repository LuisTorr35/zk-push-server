import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { COMMANDS_REPOSITORY } from './commands.repository';
import { PrismaCommandsRepository } from './prisma-commands.repository';
import { StorageModule } from '../../shared/storage/storage.module';
import { CommandPayloadRenderer } from './command-payload.renderer';
import { CommandsService } from './commands.service';

@Module({
  imports: [ConfigModule, PrismaModule, StorageModule],
  providers: [
    CommandsService,
    CommandPayloadRenderer,
    { provide: COMMANDS_REPOSITORY, useClass: PrismaCommandsRepository },
  ],
  exports: [CommandsService],
})
export class CommandsModule {}
