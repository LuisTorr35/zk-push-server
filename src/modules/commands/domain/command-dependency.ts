import type { CommandStatus } from './command';

export function dependencyState(
  mode: string | null,
  predecessor: CommandStatus | null,
): 'ready' | 'wait' | 'failed' {
  if (predecessor === null) return 'ready';
  if (predecessor === 'pending' || predecessor === 'sent') return 'wait';
  if (mode === 'finished' || predecessor === 'confirmed') return 'ready';
  return 'failed';
}
