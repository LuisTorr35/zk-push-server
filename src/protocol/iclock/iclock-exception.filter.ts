import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class IclockExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(IclockExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500)
      this.logger.error(
        'Iclock request failed',
        exception instanceof Error ? exception.stack : undefined,
      );
    response
      .status(status)
      .type('text/plain')
      .send(
        status >= 500
          ? 'ERROR'
          : exception instanceof HttpException
            ? exception.message
            : 'ERROR',
      );
  }
}
