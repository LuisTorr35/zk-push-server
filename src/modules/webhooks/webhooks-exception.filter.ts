import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { WebhooksError } from './webhooks.error';

@Catch()
export class WebhooksExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WebhooksExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500;
    let message = 'Internal server error';
    if (error instanceof WebhooksError) {
      status = { invalid: 400, missing: 404, conflict: 409 }[error.kind];
      message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      message = error.message;
    }
    if (status === 500) this.logger.error('WEBHOOKS request failed');
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, message });
  }
}
