import { dependencyState } from './command-dependency';
import type { CommandStatus } from './command';

describe('Command dependencies', () => {
  it.each<[string | null, CommandStatus | null, string]>([
    [null, null, 'ready'],
    ['confirmed', 'pending', 'wait'],
    ['confirmed', 'sent', 'wait'],
    ['confirmed', 'confirmed', 'ready'],
    ['confirmed', 'failed', 'failed'],
    ['finished', 'failed', 'ready'],
    ['finished', 'confirmed', 'ready'],
    ['finished', 'sent', 'wait'],
  ])('%s with predecessor %s becomes %s', (mode, status, expected) => {
    expect(dependencyState(mode, status)).toBe(expected);
  });
});
