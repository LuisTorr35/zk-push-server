import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DeviceMetadata } from './devices.types';

@Injectable()
export class DevicesRepository {
  constructor(private readonly prisma: PrismaService) {}

  touch(sn: string, ip?: string) {
    const lastSeenAt = new Date();
    return this.prisma.device.upsert({
      where: { sn },
      create: { sn, name: `Device ${sn}`, ip, lastSeenAt },
      // Connection updates never re-enable a disabled device.
      update: { ip, lastSeenAt },
    });
  }

  updateMetadata(id: number, metadata: DeviceMetadata) {
    return this.prisma.device.update({ where: { id }, data: metadata });
  }
}
