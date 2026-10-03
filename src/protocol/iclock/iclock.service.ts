import { Injectable, Logger } from '@nestjs/common';
import { AttendanceService } from '../../modules/attendance/attendance.service';
import { parseAttlog } from './attlog.parser';

@Injectable()
export class IclockService {
  private readonly logger = new Logger(IclockService.name);

  constructor(private readonly attendance: AttendanceService) {}

  async upload(sn: string, table: string, body: string): Promise<string> {
    // Unimplemented tables are acknowledged without creating attendance logs.
    if (table.trim().toUpperCase() !== 'ATTLOG') return 'OK';

    const result = parseAttlog(body);
    const records = result.records.map((record) => ({
      ...record,
      // localTime is a wall clock value, not a UTC instant. The Z suffix keeps
      // its components unchanged in PostgreSQL's timestamp without time zone.
      localTime: new Date(`${record.localTime.replace(' ', 'T')}Z`),
    }));
    const saved = await this.attendance.saveBatch(sn, records);

    this.logger.log(
      `ATTLOG SN=${sn} created=${saved.created} duplicates=${saved.duplicates} rejected=${result.rejected.length}`,
    );
    if (result.rejected.length > 0) {
      this.logger.warn(
        `ATTLOG SN=${sn} rejected: ${result.rejected.map((line) => line.reason).join(', ')}`,
      );
    }

    return `OK: ${result.records.length + result.rejected.length}`;
  }
}
