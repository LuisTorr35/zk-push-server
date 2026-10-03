import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { buildHandshake } from './handshake';
import { DeviceSnPipe } from './device-sn.pipe';
import { IclockExceptionFilter } from './iclock-exception.filter';
import { IclockService } from './iclock.service';

/**
 * ZKTeco ADMS / PUSH endpoints. The terminal always starts the conversation;
 * the server never calls it. Every response is plain text, not JSON.
 */
@Controller('iclock')
@UseFilters(IclockExceptionFilter)
export class IclockController {
  constructor(private readonly iclock: IclockService) {}

  @Get('cdata')
  @Header('Content-Type', 'text/plain')
  handshake(@Query('SN', DeviceSnPipe) sn: string) {
    return buildHandshake(sn);
  }

  @Post('cdata')
  @HttpCode(200) // Nest defaults POST to 201; terminals expect 200
  @Header('Content-Type', 'text/plain')
  upload(
    @Query('SN', DeviceSnPipe) sn: string,
    @Query('table') table: unknown,
    @Body() body: unknown,
  ) {
    return this.iclock.upload(
      sn,
      typeof table === 'string' ? table : '',
      typeof body === 'string' ? body : '',
    );
  }

  // No command queue yet (phase 4): always "nothing pending".
  @Get('getrequest')
  @Header('Content-Type', 'text/plain')
  getRequest(@Query('SN', DeviceSnPipe) _sn: string) {
    return 'OK';
  }

  // Body looks like: ID=12&Return=0&CMD=DATA. Processed once the queue exists.
  @Post('devicecmd')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  postDevice(@Query('SN', DeviceSnPipe) _sn: string) {
    return 'OK';
  }
}
