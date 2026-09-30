import { Body, Controller, Get, Header, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { parseAttlog } from './attlog.parser';
import { buildHandshake } from './handshake';

/**
 * ZKTeco ADMS / PUSH endpoints. The terminal always starts the conversation;
 * the server never calls it. Every response is plain text, not JSON.
 */
@Controller('iclock')
export class IclockController {
  private readonly logger = new Logger(IclockController.name);

  @Get('cdata')
  @Header('Content-Type', 'text/plain')
  handshake(@Query('SN') sn: string) {
    return buildHandshake(sn);
  }

  @Post('cdata')
  @HttpCode(200) // Nest defaults POST to 201; terminals expect 200
  @Header('Content-Type', 'text/plain')
  upload(@Query('SN') sn: string, @Query('table') table: string, @Body() body: string) {
    // Other tables are acknowledged but not processed yet. Replying OK matters:
    // otherwise the terminal keeps resending the same batch.
    if (table !== 'ATTLOG') {
      return 'OK';
    }

    // Express hands over {} instead of '' when the request has no body.
    const text = typeof body === 'string' ? body : '';
    const result = parseAttlog(text);

    this.logger.log(`ATTLOG SN=${sn} ok=${result.records.length} rejected=${result.rejected.length}`);
    if (result.rejected.length > 0) {
      this.logger.warn(`ATTLOG SN=${sn} rejected: ${result.rejected.map((r) => r.reason).join(', ')}`);
    }
    return 'OK';
  }

  // No command queue yet (phase 4): always "nothing pending".
  @Get('getrequest')
  @Header('Content-Type', 'text/plain')
  getRequest() {
    return 'OK';
  }

  // Body looks like: ID=12&Return=0&CMD=DATA. Processed once the queue exists.
  @Post('devicecmd')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  postDevice() {
    return 'OK';
  }
}
