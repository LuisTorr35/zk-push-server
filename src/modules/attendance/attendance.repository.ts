import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { OutboxWriter } from '../webhooks/outbox.writer';
import type { AttendanceRecord } from './attendance.types';

@Injectable()
export class AttendanceRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
  ) {}

  async insertBatch(
    deviceId: number,
    records: readonly AttendanceRecord[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.attendanceLog.createManyAndReturn({
        data: records.map((record) => ({ ...record, deviceId })),
        skipDuplicates: true,
      });
      await this.outbox.attendance(tx, rows);
      return rows.length;
    });
  }
}
