import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe. Used by Docker, load balancers and monitoring to tell whether
 * the process is responding. It does not touch the database yet: that arrives
 * in phase 3, once Prisma exists.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  check() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
