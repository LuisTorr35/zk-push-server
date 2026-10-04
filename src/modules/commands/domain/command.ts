export const MAX_COMMAND_ATTEMPTS = 5;
export type CommandStatus = 'pending' | 'sent' | 'confirmed' | 'failed';

export type CommandState = {
  status: CommandStatus;
  attempts: number;
  maxAttempts: number;
  sentAt: Date | null;
  respondedAt: Date | null;
  returnCode: number | null;
};

/** Pure state transitions. Time is supplied by the caller. */
export class Command {
  private state: CommandState;

  constructor(state: CommandState) {
    if (
      !Number.isInteger(state.maxAttempts) ||
      state.maxAttempts < 1 ||
      state.maxAttempts > MAX_COMMAND_ATTEMPTS ||
      !Number.isInteger(state.attempts) ||
      state.attempts < 0 ||
      state.attempts > state.maxAttempts
    ) {
      throw new Error('Invalid command attempt limits');
    }
    this.state = {
      status: state.status,
      attempts: state.attempts,
      maxAttempts: state.maxAttempts,
      sentAt: state.sentAt,
      respondedAt: state.respondedAt,
      returnCode: state.returnCode,
    };
  }

  get snapshot(): CommandState {
    return { ...this.state };
  }

  send(now: Date): void {
    if (
      this.state.status !== 'pending' ||
      this.state.attempts >= this.state.maxAttempts
    ) {
      throw new Error('Command cannot be sent');
    }
    this.state = {
      ...this.state,
      status: 'sent',
      attempts: this.state.attempts + 1,
      sentAt: now,
      respondedAt: null,
      returnCode: null,
    };
  }

  /** A pending command can fail before delivery when its prerequisites are lost. */
  failBeforeSend(): boolean {
    if (this.state.status !== 'pending') return false;
    this.state.status = 'failed';
    return true;
  }

  recoverExpired(now: Date, expiresAt: Date): boolean {
    if (this.state.status !== 'sent' || now < expiresAt) return false;
    this.state.status = this.retryStatus();
    return true;
  }

  respond(attemptNumber: number, returnCode: number, now: Date): boolean {
    if (
      this.state.status === 'confirmed' ||
      this.state.status === 'failed' ||
      attemptNumber < 1 ||
      attemptNumber > this.state.attempts
    )
      return false;
    // A delayed success can finish an active command. Older failures must not
    // undo a newer delivery, and an expired failure cannot retry twice.
    if (
      returnCode !== 0 &&
      (attemptNumber !== this.state.attempts || this.state.status !== 'sent')
    )
      return false;
    this.state = {
      ...this.state,
      status: returnCode === 0 ? 'confirmed' : this.retryStatus(),
      returnCode,
      respondedAt: now,
    };
    return true;
  }

  private retryStatus(): 'pending' | 'failed' {
    return this.state.attempts >= this.state.maxAttempts ? 'failed' : 'pending';
  }
}
