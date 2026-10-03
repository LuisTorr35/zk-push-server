import { Injectable } from '@nestjs/common';
import { DevicesRepository } from './devices.repository';
import { DeviceDisabledError } from './device-disabled.error';
import type { DeviceMetadata } from './devices.types';

@Injectable()
export class DevicesService {
  constructor(private readonly repository: DevicesRepository) {}

  async connect(sn: string, ip?: string) {
    const device = await this.repository.touch(sn, ip);
    if (!device.enabled) throw new DeviceDisabledError();
    return device;
  }

  updateMetadata(id: number, metadata: DeviceMetadata) {
    return this.repository.updateMetadata(id, metadata);
  }
}
