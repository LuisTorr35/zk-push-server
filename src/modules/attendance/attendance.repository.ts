import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { AttendanceRecord } from './attendance.types';

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertBatch(
    deviceSn: string,
    records: readonly AttendanceRecord[],
  ): Promise<number> {
    const result = await this.prisma.attendanceLog.createMany({
      data: records.map((record) => ({ ...record, deviceSn })),
      skipDuplicates: true,
    });

    return result.count;
  }
}
