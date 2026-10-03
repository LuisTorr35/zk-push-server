import type { CommandState } from './domain/command';

export type CommandRecord = CommandState & {
  id: number;
  deviceId: number;
  type: string;
  payload: string;
  priority: number;
  dedupeKey: string | null;
  createdAt: Date;
};

export type EnqueueCommand = {
  deviceId: number;
  type: string;
  payload: string;
  priority?: number;
  dedupeKey?: string;
};

export type CommandAttempt = {
  id: number;
  commandId: number;
  number: number;
  sentAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  returnCode: number | null;
};

export type CommandResponse = { id: number; returnCode: number };
export type CommandDelivery = { id: number; commandId: number; payload: string };
