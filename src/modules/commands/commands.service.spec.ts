import { ConfigService } from '@nestjs/config';
import { CommandsService } from './commands.service';
import type { Env } from '../../shared/config/env.schema';
import type { EnqueueCommand } from './commands.types';

describe('CommandsService input', () => {
  const lock = jest.fn();
  const service = new CommandsService(
    { withDeviceLock: lock },
    new ConfigService<Env, true>({ COMMAND_ACK_TIMEOUT_SECONDS: 60 }),
  );
  const valid: EnqueueCommand = {
    deviceId: 1,
    type: 'USERINFO',
    payload: 'DATA QUERY USERINFO',
  };

  beforeEach(() => lock.mockReset());

  it.each([
    { deviceId: 0 },
    { deviceId: 1.5 },
    { type: '' },
    { payload: '' },
    { payload: 'A\nB' },
    { payload: 'A\rB' },
    { priority: 1.5 },
    { dedupeKey: '' },
    { type: 'BIOPHOTO_UPLOAD' },
    { payload: 'DATA UPDATE USERPIC\tPIN=1001\tContent=AAAA' },
    { payload: 'DATA UPDATE BIOPHOTO\tPIN=1001\tContent=AAAA' },
  ])('rejects invalid or unsupported input %j before persisting', (change) => {
    expect(() => service.enqueue({ ...valid, ...change })).toThrow();
    expect(lock).not.toHaveBeenCalled();
  });
});
