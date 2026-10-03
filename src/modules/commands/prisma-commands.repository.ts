import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { DeviceDisabledError } from '../devices/device-disabled.error';
import { CommandInputError } from './command-input.error';
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
        findPending: () =>
          tx.command.findFirst({
            where: { deviceId, status: 'pending' },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          }),
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
