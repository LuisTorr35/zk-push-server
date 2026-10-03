import { Module } from '@nestjs/common';
import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { COMMANDS_REPOSITORY } from './commands.repository';
import { PrismaCommandsRepository } from './prisma-commands.repository';
import { CommandsService } from './commands.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    CommandsService,
    { provide: COMMANDS_REPOSITORY, useClass: PrismaCommandsRepository },
  ],
  exports: [CommandsService],
})
export class CommandsModule {}
