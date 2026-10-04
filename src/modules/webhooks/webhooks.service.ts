import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksError } from './webhooks.error';

const uuid = z.string().uuid();
const querySchema = z
  .object({
    status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();
const cursorSchema = z.object({ createdAt: z.string().datetime(), id: uuid }).strict();

@Injectable()
export class WebhooksService {
  constructor(private readonly repository: WebhooksRepository) {}

  async list(input: unknown) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new WebhooksError('invalid', 'Invalid delivery query');
    const query = parsed.data;
    let cursor;
    if (query.cursor) {
      try {
        const decoded = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
        cursor = { id: decoded.id, createdAt: new Date(decoded.createdAt) };
      } catch {
        throw new WebhooksError('invalid', 'Invalid delivery cursor');
      }
    }
    const rows = await this.repository.list(query.status, cursor, query.limit);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  }

  async get(id: string) {
    this.validateId(id);
    const row = await this.repository.get(id);
    if (!row) throw new WebhooksError('missing', 'Delivery not found');
    const { body, ...metadata } = row;
    return { ...metadata, event: JSON.parse(body) as unknown };
  }

  async retry(id: string) {
    this.validateId(id);
    if (!(await this.repository.retry(id))) {
      if (!(await this.repository.get(id)))
        throw new WebhooksError('missing', 'Delivery not found');
      throw new WebhooksError('conflict', 'Only failed deliveries can be retried');
    }
    return { id, status: 'pending' };
  }

  private validateId(id: string) {
    if (!uuid.safeParse(id).success)
      throw new WebhooksError('invalid', 'Invalid delivery ID');
  }
}
