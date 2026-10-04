import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, text, urlencoded } from 'express';

/** Terminals send text under several content types; the API uses JSON/multipart. */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.use('/iclock', text({ type: () => true, limit: '25mb' }));
  app.use('/api', json({ limit: '1mb' }), urlencoded({ extended: false, limit: '1mb' }));
}
