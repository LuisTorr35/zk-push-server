import type { CommandState } from './domain/command';
import type { CommandRecord, CommandAttempt, EnqueueCommand } from './commands.types';

export const COMMANDS_REPOSITORY = Symbol('COMMANDS_REPOSITORY');

export interface CommandsTransaction {
  findDuplicate(type: string, dedupeKey: string): Promise<CommandRecord | null>;
  create(input: EnqueueCommand): Promise<CommandRecord>;
  findSent(): Promise<CommandRecord | null>;
  findPending(): Promise<CommandRecord | null>;
  save(id: number, state: CommandState): Promise<void>;
  fail(id: number, reason: string): Promise<void>;
  createAttempt(
    commandId: number,
    number: number,
    sentAt: Date,
    expiresAt: Date,
  ): Promise<CommandAttempt>;
  findAttempt(commandId: number, number: number): Promise<CommandAttempt>;
  findResponseAttempt(
    id: number,
  ): Promise<(CommandAttempt & { command: CommandRecord }) | null>;
  recordResponse(id: number, returnCode: number, respondedAt: Date): Promise<void>;
}

export interface CommandsRepository {
  withDeviceLock<T>(
    deviceId: number,
    work: (transaction: CommandsTransaction) => Promise<T>,
  ): Promise<T>;
}
