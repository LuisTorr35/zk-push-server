import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class DeviceSnPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value.trim())) {
      throw new BadRequestException('BAD SN');
    }
    return value.trim();
  }
}
