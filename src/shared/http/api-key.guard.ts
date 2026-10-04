import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}
  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest<Request>().headers['x-api-key'];
    const expected = this.config.get('API_KEY', { infer: true });
    if (
      typeof supplied !== 'string' ||
      !timingSafeEqual(this.digest(supplied), this.digest(expected))
    )
      throw new UnauthorizedException('Invalid API key');
    return true;
  }
  private digest(value: string) {
    return createHash('sha256').update(value).digest();
  }
}
