import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { AttendanceRecord } from './attendance.types';

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertBatch(
    deviceId: number,
    records: readonly AttendanceRecord[],
  ): Promise<number> {
    const result = await this.prisma.attendanceLog.createMany({
      data: records.map((record) => ({ ...record, deviceId })),
      skipDuplicates: true,
    });

    return result.count;
  }
}
