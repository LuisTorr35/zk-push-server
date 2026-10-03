import { Injectable, Logger } from '@nestjs/common';
import { AttendanceService } from '../../modules/attendance/attendance.service';
import { parseAttlog } from './attlog.parser';
import { DevicesService } from '../../modules/devices/devices.service';
import { buildHandshake } from './handshake';
import { parseOptions } from './options.parser';
import { CommandsService } from '../../modules/commands/commands.service';
import { parseDevicecmd } from './devicecmd.parser';

@Injectable()
export class IclockService {
  private readonly logger = new Logger(IclockService.name);

  constructor(
    private readonly attendance: AttendanceService,
    private readonly devices: DevicesService,
    private readonly commands: CommandsService,
  ) {}

  async handshake(sn: string, ip?: string): Promise<string> {
    await this.devices.connect(sn, ip);
    return buildHandshake(sn);
  }

  async getRequest(sn: string, ip?: string): Promise<string> {
    const device = await this.devices.connect(sn, ip);
    const delivery = await this.commands.next(device.id);
    return delivery ? `C:${delivery.id}:${delivery.payload}` : 'OK';
  }

  async devicecmd(sn: string, body: string, ip?: string): Promise<string> {
    const device = await this.devices.connect(sn, ip);
    const result = parseDevicecmd(body);
    await this.commands.respond(device.id, result.records);
    if (result.rejected > 0)
      this.logger.warn(`DEVICECMD SN=${sn} rejected=${result.rejected}`);
    return 'OK';
  }

  async upload(sn: string, table: string, body: string, ip?: string): Promise<string> {
    const device = await this.devices.connect(sn, ip);
    const normalizedTable = table.trim().toUpperCase();
    if (normalizedTable === 'OPTIONS') {
      const metadata = parseOptions(body);
      if (Object.keys(metadata).length > 0)
        await this.devices.updateMetadata(device.id, metadata);
      return 'OK: 1';
    }
    // Unimplemented tables are acknowledged without creating attendance logs.
    if (normalizedTable !== 'ATTLOG') return 'OK';

    const result = parseAttlog(body);
    const records = result.records.map((record) => ({
      ...record,
      // localTime is a wall clock value, not a UTC instant. The Z suffix keeps
      // its components unchanged in PostgreSQL's timestamp without time zone.
      localTime: new Date(`${record.localTime.replace(' ', 'T')}Z`),
    }));
    const saved = await this.attendance.saveBatch(device.id, records);

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
