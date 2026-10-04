import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AttendanceLog, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../shared/config/env.schema';

@Injectable()
export class OutboxWriter {
  private readonly enabled: boolean;
  private readonly maxAttempts: number;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = Boolean(config.get('WEBHOOK_URL', { infer: true }));
    this.maxAttempts = config.get('WEBHOOK_MAX_ATTEMPTS', { infer: true });
  }

  async attendance(tx: Prisma.TransactionClient, rows: AttendanceLog[]): Promise<void> {
    if (!this.enabled || !rows.length) return;
    const device = await tx.device.findUniqueOrThrow({ where: { id: rows[0].deviceId } });
    await tx.webhookDelivery.createMany({
      data: rows.map((row) =>
        this.event(`attendance:${row.id}`, 'attendance.created', row.receivedAt, {
          attendanceId: row.id,
          sn: device.sn,
          pin: row.pin,
          // This is the terminal's clock, without a timezone conversion.
          localTime: row.localTime.toISOString().slice(0, 19).replace('T', ' '),
          status: row.status,
          verifyType: row.verifyType,
          receivedAt: row.receivedAt.toISOString(),
        }),
      ),
    });
  }

  async command(tx: Prisma.TransactionClient, id: number): Promise<void> {
    if (!this.enabled) return;
    const command = await tx.command.findUniqueOrThrow({
      where: { id },
      include: { device: { select: { sn: true } }, person: { select: { pin: true } } },
    });
    if (command.status !== 'confirmed' && command.status !== 'failed') return;
    await tx.webhookDelivery.create({
      data: this.event(
        `command:${id}:finished`,
        `command.${command.status}`,
        new Date(),
        {
          commandId: id,
          type: command.type,
          operationId: command.operationId,
          pin: command.person?.pin ?? null,
          sn: command.device.sn,
          attempts: command.attempts,
          maxAttempts: command.maxAttempts,
          returnCode: command.returnCode,
          ...(command.status === 'failed' ? { reason: command.failureReason } : {}),
        },
      ),
    });
  }

  private event(sourceKey: string, type: string, occurredAt: Date, data: object) {
    const id = randomUUID();
    return {
      id,
      sourceKey,
      type,
      maxAttempts: this.maxAttempts,
      // Retries sign and transmit these original bytes, never a reconstructed object.
      body: JSON.stringify({
        id,
        type,
        version: 1,
        occurredAt: occurredAt.toISOString(),
        data,
      }),
    };
  }
}
