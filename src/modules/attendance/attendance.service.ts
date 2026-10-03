import { Injectable } from '@nestjs/common';
import { AttendanceRepository } from './attendance.repository';
import type { AttendanceBatchResult, AttendanceRecord } from './attendance.types';

@Injectable()
export class AttendanceService {
  constructor(private readonly repository: AttendanceRepository) {}

  async saveBatch(
    deviceId: number,
    records: readonly AttendanceRecord[],
  ): Promise<AttendanceBatchResult> {
    if (records.length === 0) {
      return { created: 0, duplicates: 0 };
    }

    const created = await this.repository.insertBatch(deviceId, records);
    return { created, duplicates: records.length - created };
  }
}
