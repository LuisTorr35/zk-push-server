import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.schema';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService<Env, true>) {
    super({ datasourceUrl: config.get('DATABASE_URL', { infer: true }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  // Workers drain active deliveries in beforeApplicationShutdown while DB access stays open.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
