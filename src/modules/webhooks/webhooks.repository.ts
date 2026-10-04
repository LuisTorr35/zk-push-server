import { Injectable } from '@nestjs/common';
import type { WebhookDelivery, WebhookStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

export type DeliveryCursor = { createdAt: Date; id: string };
export type DeliveryResult = { httpCode: number | null; error: string | null };
export const DELIVERY_LEASE_MS = 60000;

@Injectable()
export class WebhooksRepository {
  constructor(private readonly prisma: PrismaService) {}

  reserve(now = new Date()): Promise<WebhookDelivery[]> {
    return this.prisma.$transaction(async (tx) => {
      // Expired final reservations are retained as failed, including worker crashes.
      await tx.$executeRaw`
        WITH exhausted AS (
          SELECT id FROM "WebhookDelivery"
          WHERE status = 'sending' AND "lockedUntil" <= ${now}
            AND attempts >= "maxAttempts"
          ORDER BY "lockedUntil", id FOR UPDATE SKIP LOCKED LIMIT 100
        )
        UPDATE "WebhookDelivery" AS d SET status = 'failed', "lockToken" = NULL,
          "lockedUntil" = NULL, "lastError" = 'lease_expired', "updatedAt" = ${now}
        FROM exhausted WHERE d.id = exhausted.id
      `;
      return tx.$queryRaw<WebhookDelivery[]>`
        WITH due AS (
          SELECT id FROM "WebhookDelivery"
          WHERE attempts < "maxAttempts" AND (
            (status = 'pending' AND "nextAttemptAt" <= ${now}) OR
            (status = 'sending' AND "lockedUntil" <= ${now})
          )
          ORDER BY "nextAttemptAt", "createdAt", id
          FOR UPDATE SKIP LOCKED LIMIT 5
        )
        UPDATE "WebhookDelivery" AS d SET status = 'sending', attempts = d.attempts + 1,
          "lockToken" = gen_random_uuid()::text,
          "lockedUntil" = ${new Date(now.getTime() + DELIVERY_LEASE_MS)},
          "updatedAt" = ${now}
        FROM due WHERE d.id = due.id RETURNING d.*
      `;
    });
  }

  async finish(
    delivery: WebhookDelivery,
    result: DeliveryResult,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const delivered = result.error === null;
    const updated = await this.prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: 'sending', lockToken: delivery.lockToken },
      data: {
        status: delivered
          ? 'delivered'
          : delivery.attempts >= delivery.maxAttempts
            ? 'failed'
            : 'pending',
        lastHttpCode: result.httpCode,
        lastError: result.error,
        nextAttemptAt,
        deliveredAt: delivered ? new Date() : null,
        lockToken: null,
        lockedUntil: null,
      },
    });
    return updated.count === 1;
  }

  list(
    status: WebhookStatus | undefined,
    cursor: DeliveryCursor | undefined,
    limit: number,
  ) {
    return this.prisma.webhookDelivery.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      // List responses do not load serialized event bodies.
      omit: { body: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  }

  get(id: string) {
    return this.prisma.webhookDelivery.findUnique({ where: { id } });
  }

  async retry(id: string): Promise<boolean> {
    const result = await this.prisma.webhookDelivery.updateMany({
      where: { id, status: 'failed' },
      data: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockToken: null,
        lockedUntil: null,
        lastHttpCode: null,
        lastError: null,
        deliveredAt: null,
      },
    });
    return result.count === 1;
  }
}
