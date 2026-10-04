import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { PersonsError } from './persons.error';
import {
  InvalidPhotoError,
  PhotoStorageError,
} from '../../shared/storage/photo-storage.error';

@Catch()
export class PersonsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PersonsExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500;
    let message = 'Internal server error';
    if (error instanceof PersonsError) {
      status = { invalid: 400, missing: 404, conflict: 409 }[error.kind];
      message = error.message;
    } else if (error instanceof InvalidPhotoError) {
      status = 400;
      message = error.message;
    } else if (error instanceof PhotoStorageError) {
      status = error.permanent ? 404 : 503;
      message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      message = error.message;
    }
    if (status === 500) this.logger.error('PERSONS request failed');
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, message });
  }
}
