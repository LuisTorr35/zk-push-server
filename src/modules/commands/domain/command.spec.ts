import { Command, MAX_COMMAND_ATTEMPTS, type CommandState } from './command';

const start = new Date('2026-10-01T00:00:00Z');
const later = new Date(start.getTime() + 60000);
const pending = (): CommandState => ({
  status: 'pending',
  attempts: 0,
  maxAttempts: MAX_COMMAND_ATTEMPTS,
  sentAt: null,
  respondedAt: null,
  returnCode: null,
});

describe('Command domain', () => {
  it('counts a send and waits until the exact deadline before recovering', () => {
    const command = new Command(pending());
    command.send(start);
    expect(command.snapshot).toMatchObject({
      status: 'sent',
      attempts: 1,
      sentAt: start,
    });
    expect(command.recoverExpired(new Date(later.getTime() - 1), later)).toBe(false);
    expect(command.recoverExpired(later, later)).toBe(true);
    expect(command.snapshot.status).toBe('pending');
    expect(command.recoverExpired(later, later)).toBe(false);
  });

  it.each(['error', 'timeout'])('fails after five total sends with %s', (cause) => {
    const command = new Command(pending());
    for (let attempt = 1; attempt <= 5; attempt++) {
      command.send(start);
      if (cause === 'error') command.respond(attempt, -1004, later);
      else command.recoverExpired(later, later);
      expect(command.snapshot.status).toBe(attempt === 5 ? 'failed' : 'pending');
    }
    expect(command.snapshot.attempts).toBe(5);
    expect(() => command.send(later)).toThrow('Command cannot be sent');
    expect(command.respond(5, 0, later)).toBe(false);
  });

  it('confirms once and keeps confirmed commands terminal', () => {
    const command = new Command(pending());
    command.send(start);
    expect(command.respond(1, 0, later)).toBe(true);
    expect(command.snapshot).toMatchObject({
      status: 'confirmed',
      returnCode: 0,
      respondedAt: later,
    });
    expect(command.respond(1, -1, later)).toBe(false);
    expect(command.recoverExpired(later, later)).toBe(false);
    expect(() => command.send(later)).toThrow();
  });

  it('accepts a delayed success but ignores an older failure', () => {
    const command = new Command(pending());
    command.send(start);
    command.recoverExpired(later, later);
    command.send(later);
    expect(command.respond(1, -1, later)).toBe(false);
    expect(command.snapshot).toMatchObject({ status: 'sent', attempts: 2 });
    expect(command.respond(1, 0, later)).toBe(true);
    expect(command.snapshot.status).toBe('confirmed');
  });

  it('accepts success while waiting for a retry but does not retry an expired failure twice', () => {
    const command = new Command(pending());
    command.send(start);
    command.recoverExpired(later, later);
    expect(command.respond(1, -1, later)).toBe(false);
    expect(command.respond(1, 0, later)).toBe(true);
  });

  it('rejects unsent and unknown attempt numbers and overlapping sends', () => {
    const command = new Command(pending());
    expect(command.respond(1, 0, later)).toBe(false);
    command.send(start);
    expect(() => command.send(later)).toThrow();
    expect(command.respond(0, 0, later)).toBe(false);
    expect(command.respond(2, 0, later)).toBe(false);
  });
});
