import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { IclockClient } from './iclock-client';
import { SimulatorError, type SimulatorOptions } from './options';

export type SimulatorDependencies = {
  signal: AbortSignal;
  log: (message: string) => void;
  fetcher?: typeof fetch;
  readBatch?: (path: string) => Promise<Buffer>;
};

export async function attendanceBatch(
  options: SimulatorOptions,
  readBatch: (path: string) => Promise<Buffer> = readFile,
): Promise<Buffer> {
  if (!options.file)
    return Buffer.from(`${options.pin}\t${options.localTime}\t0\t15\r\n`);
  try {
    return await readBatch(options.file);
  } catch {
    throw new SimulatorError('Could not read ATTLOG file');
  }
}

export async function runSimulator(
  options: SimulatorOptions,
  dependencies: SimulatorDependencies,
): Promise<void> {
  const { signal, log } = dependencies;
  // Read once before connecting: repeats replay exactly the same bytes and clock.
  const batch =
    options.scenario === 'poll'
      ? undefined
      : await attendanceBatch(options, dependencies.readBatch);
  signal.throwIfAborted();
  const client = new IclockClient(options.url, options.sn, signal, dependencies.fetcher);
  await client.handshake();
  log(`HANDSHAKE sn=${options.sn} registered`);
  if (options.scenario === 'smoke') {
    await client.metadata();
    log('OPTIONS acknowledged');
  }
  if (batch) {
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      const lines = await client.attendance(batch);
      log(`ATTLOG batch=${repeat} lines=${lines} acknowledged`);
    }
  }
  if (options.scenario === 'attendance') return;
  for (let poll = 1; options.watch || poll <= options.polls; poll++) {
    signal.throwIfAborted();
    const command = await client.poll();
    if (!command) log(`POLL number=${poll} empty`);
    else {
      log(`COMMAND attempt=${command.attemptId} received`);
      if (options.ack === 'none') log(`ACK attempt=${command.attemptId} skipped`);
      else {
        const code = options.ack === 'success' ? 0 : options.returnCode;
        await client.acknowledge(command.attemptId, code);
        log(`ACK attempt=${command.attemptId} return=${code} acknowledged`);
      }
    }
    if (options.watch || poll < options.polls)
      await delay(options.intervalMs, undefined, { signal });
  }
}
