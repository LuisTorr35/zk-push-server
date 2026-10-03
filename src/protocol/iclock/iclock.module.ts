import { Module } from '@nestjs/common';
import { IclockController } from './iclock.controller';
import { AttendanceModule } from '../../modules/attendance/attendance.module';
import { DeviceSnPipe } from './device-sn.pipe';
import { IclockExceptionFilter } from './iclock-exception.filter';
import { IclockService } from './iclock.service';

@Module({
  imports: [AttendanceModule],
  controllers: [IclockController],
  providers: [IclockService, DeviceSnPipe, IclockExceptionFilter],
})
export class IclockModule {}
