import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Ip,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { DeviceSnPipe } from './device-sn.pipe';
import { IclockExceptionFilter } from './iclock-exception.filter';
import { IclockService } from './iclock.service';

/**
 * ZKTeco ADMS / PUSH endpoints. The terminal always starts the conversation;
 * the server never calls it. These routes accept requests without a session.
 * Valid serial numbers are registered automatically; Device.enabled controls
 * whether a terminal can operate. Every response is plain text, not JSON.
 */
@Controller('iclock')
@UseFilters(IclockExceptionFilter)
export class IclockController {
  constructor(private readonly iclock: IclockService) {}

  @Get('cdata')
  @Header('Content-Type', 'text/plain')
  handshake(@Query('SN', DeviceSnPipe) sn: string, @Ip() ip: string) {
    return this.iclock.handshake(sn, ip);
  }

  @Post('cdata')
  @HttpCode(200) // Nest defaults POST to 201; terminals expect 200
  @Header('Content-Type', 'text/plain')
  upload(
    @Query('SN', DeviceSnPipe) sn: string,
    @Query('table') table: unknown,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    return this.iclock.upload(
      sn,
      typeof table === 'string' ? table : '',
      typeof body === 'string' ? body : '',
      ip,
    );
  }

  // Polling delivers one command attempt while the device has no active delivery.
  @Get('getrequest')
  @Header('Content-Type', 'text/plain')
  getRequest(@Query('SN', DeviceSnPipe) sn: string, @Ip() ip: string) {
    return this.iclock.getRequest(sn, ip);
  }

  // ID identifies the delivery attempt, so delayed responses remain distinguishable.
  @Post('devicecmd')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  postDevice(
    @Query('SN', DeviceSnPipe) sn: string,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    return this.iclock.devicecmd(sn, typeof body === 'string' ? body : '', ip);
  }
}
