import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/config/env.schema';
import { COMMANDS_REPOSITORY, type CommandsRepository } from './commands.repository';
import { CommandInputError } from './command-input.error';
import { Command } from './domain/command';
import type { EnqueueCommand, CommandDelivery, CommandResponse } from './commands.types';

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    @Inject(COMMANDS_REPOSITORY) private readonly repository: CommandsRepository,
    private readonly config: ConfigService<Env, true>,
  ) {}

  enqueue(input: EnqueueCommand) {
    this.validateInput(input);
    return this.repository.withDeviceLock(input.deviceId, async (tx) => {
      const existing = input.dedupeKey
        ? await tx.findDuplicate(input.type, input.dedupeKey)
        : null;
      return existing
        ? { command: existing, duplicate: true }
        : { command: await tx.create(input), duplicate: false };
    });
  }

  async next(deviceId: number): Promise<CommandDelivery | null> {
    const timeout = this.config.get('COMMAND_ACK_TIMEOUT_SECONDS', { infer: true });
    const result = await this.repository.withDeviceLock(deviceId, async (tx) => {
      const now = new Date();
      const sent = await tx.findSent();
      if (sent) {
        const attempt = await tx.findAttempt(sent.id, sent.attempts);
        const command = new Command(sent);
        if (!command.recoverExpired(now, attempt.expiresAt)) return null;
        await tx.save(sent.id, command.snapshot);
      }
      const pending = await tx.findPending();
      if (!pending) return null;
      const command = new Command(pending);
      command.send(now);
      await tx.save(pending.id, command.snapshot);
      const attempt = await tx.createAttempt(
        pending.id,
        command.snapshot.attempts,
        now,
        new Date(now.getTime() + timeout * 1000),
      );
      return { id: attempt.id, commandId: pending.id, payload: pending.payload };
    });
    if (result)
      this.logger.log(
        `COMMAND device=${deviceId} command=${result.commandId} attempt=${result.id} sent`,
      );
    return result;
  }

  async respond(deviceId: number, responses: readonly CommandResponse[]): Promise<void> {
    const results = await this.repository.withDeviceLock(deviceId, async (tx) => {
      const results: string[] = [];
      for (const response of responses) {
        const attempt = await tx.findResponseAttempt(response.id);
        if (!attempt || attempt.respondedAt !== null) {
          results.push(`attempt=${response.id} ignored`);
          continue;
        }
        const now = new Date();
        await tx.recordResponse(attempt.id, response.returnCode, now);
        const command = new Command(attempt.command);
        const changed = command.respond(attempt.number, response.returnCode, now);
        if (changed) await tx.save(attempt.commandId, command.snapshot);
        results.push(
          `command=${attempt.commandId} attempt=${attempt.id} return=${response.returnCode} status=${command.snapshot.status}`,
        );
      }
      return results;
    });
    for (const result of results) this.logger.log(`COMMAND device=${deviceId} ${result}`);
  }

  private validateInput(input: EnqueueCommand): void {
    if (
      !Number.isInteger(input.deviceId) ||
      input.deviceId < 1 ||
      input.deviceId > 2147483647 ||
      typeof input.type !== 'string' ||
      !input.type.trim() ||
      typeof input.payload !== 'string' ||
      !input.payload.trim() ||
      /[\r\n]/.test(input.payload) ||
      (input.priority !== undefined &&
        (!Number.isInteger(input.priority) || Math.abs(input.priority) > 2147483647)) ||
      (input.dedupeKey !== undefined &&
        (typeof input.dedupeKey !== 'string' || !input.dedupeKey.trim()))
    ) {
      throw new CommandInputError('Invalid command input');
    }
    if (
      /BIOPHOTO|USERPIC|ATTPHOTO/i.test(input.type) ||
      /\b(?:BIOPHOTO|USERPIC|ATTPHOTO)\b/i.test(input.payload)
    ) {
      throw new CommandInputError(
        'Photo commands require photo storage and are not supported yet',
      );
    }
  }
}
