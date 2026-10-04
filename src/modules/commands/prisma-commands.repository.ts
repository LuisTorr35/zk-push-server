import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { DeviceDisabledError } from '../devices/device-disabled.error';
import { CommandInputError } from './command-input.error';
import { dependencyState } from './domain/command-dependency';
import { Command } from './domain/command';
import type { CommandsRepository, CommandsTransaction } from './commands.repository';

@Injectable()
export class PrismaCommandsRepository implements CommandsRepository {
  constructor(private readonly prisma: PrismaService) {}

  withDeviceLock<T>(
    deviceId: number,
    work: (transaction: CommandsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const devices = await tx.$queryRaw<{ id: number; enabled: boolean }[]>`
        SELECT id, enabled FROM "Device" WHERE id = ${deviceId} FOR UPDATE
      `;
      if (!devices[0]) throw new CommandInputError('Device not found');
      if (!devices[0].enabled) throw new DeviceDisabledError();

      const transaction: CommandsTransaction = {
        findDuplicate: (type, dedupeKey) =>
          tx.command.findFirst({
            where: { deviceId, type, dedupeKey, status: { in: ['pending', 'sent'] } },
          }),
        create: (input) =>
          tx.command.create({
            data: {
              deviceId,
              type: input.type,
              payload: input.payload,
              priority: input.priority,
              dedupeKey: input.dedupeKey,
            },
          }),
        findSent: () => tx.command.findFirst({ where: { deviceId, status: 'sent' } }),
        findPending: async () => {
          const pending = await tx.command.findMany({
            where: { deviceId, status: 'pending' },
            include: { predecessor: { select: { status: true } } },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          });
          const failed = new Set<number>();
          for (const candidate of pending) {
            // Refresh dependency state: an earlier candidate may just have failed.
            const state = dependencyState(
              candidate.dependencyMode,
              candidate.predecessorId && failed.has(candidate.predecessorId)
                ? 'failed'
                : (candidate.predecessor?.status ?? null),
            );
            if (state === 'ready') return candidate;
            if (state === 'failed') {
              const command = new Command(candidate);
              command.failBeforeSend();
              await tx.command.update({
                where: { id: candidate.id },
                data: { ...command.snapshot, failureReason: 'Predecessor failed' },
              });
              failed.add(candidate.id);
            }
          }
          return null;
        },
        fail: async (id, reason) => {
          const record = await tx.command.findUniqueOrThrow({ where: { id } });
          const command = new Command(record);
          if (!command.failBeforeSend()) return;
          await tx.command.update({
            where: { id },
            data: { ...command.snapshot, failureReason: reason },
          });
        },
        save: async (id, state) => {
          await tx.command.update({ where: { id }, data: state });
        },
        createAttempt: (commandId, number, sentAt, expiresAt) =>
          tx.commandAttempt.create({
            data: { commandId, number, sentAt, expiresAt },
          }),
        findAttempt: (commandId, number) =>
          tx.commandAttempt.findUniqueOrThrow({
            where: { commandId_number: { commandId, number } },
          }),
        findResponseAttempt: (id) =>
          tx.commandAttempt.findFirst({
            where: { id, command: { deviceId } },
            include: { command: true },
          }),
        recordResponse: async (id, returnCode, respondedAt) => {
          await tx.commandAttempt.update({
            where: { id },
            data: { returnCode, respondedAt },
          });
        },
      };
      return work(transaction);
    });
  }
}
