import { parseOptions, type SimulatorOptions } from './options';
import { attendanceBatch, runSimulator } from './simulator';

const text = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'text/plain' } });
const options = (args: string[] = []): SimulatorOptions => {
  const parsed = parseOptions(args, new Date('2026-10-04T08:30:00Z'));
  if (parsed.help) throw new Error('Expected options');
  return parsed.options;
};
describe('simulator scenarios', () => {
  it('replays the same file bytes and never logs a payload', async () => {
    const bytes = Buffer.from('1001\t2026-10-04 08:30:00\t0\t15\r\n');
    const readBatch = jest.fn(async () => bytes);
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(text('GET OPTION FROM: ABC1234567890'))
      .mockResolvedValueOnce(text('OK: 1'))
      .mockResolvedValueOnce(text('OK: 1'))
      .mockResolvedValueOnce(text('OK: 1'))
      .mockResolvedValueOnce(text('C:17:DATA UPDATE BIOPHOTO\tContent=PRIVATE'))
      .mockResolvedValueOnce(text('OK'));
    const log = jest.fn();
    await runSimulator(
      options(['--file', 'batch.txt', '--repeat', '2', '--polls', '1']),
      { signal: new AbortController().signal, log, readBatch, fetcher },
    );
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(Buffer.from(fetcher.mock.calls[2][1].body)).toEqual(bytes);
    expect(Buffer.from(fetcher.mock.calls[3][1].body)).toEqual(bytes);
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/PRIVATE|BIOPHOTO|Content=/);
    expect(log).toHaveBeenCalledWith('ACK attempt=17 return=0 acknowledged');
  });
  it('fails before contacting the server if a file cannot be read', async () => {
    const fetcher = jest.fn();
    await expect(
      runSimulator(options(['--file', 'missing.txt']), {
        signal: new AbortController().signal,
        log: jest.fn(),
        fetcher,
        readBatch: async () => {
          throw new Error('Private file details');
        },
      }),
    ).rejects.toThrow('Could not read ATTLOG file');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('generates one valid row and preserves empty files', async () => {
    expect((await attendanceBatch(options())).toString()).toBe(
      '1001\t2026-10-04 08:30:00\t0\t15\r\n',
    );
    expect(
      await attendanceBatch(options(['--file', 'empty.txt']), async () =>
        Buffer.alloc(0),
      ),
    ).toEqual(Buffer.alloc(0));
  });
  it.each(['success', 'error', 'none'])('uses %s ACK behavior', async (ack) => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(text('GET OPTION FROM: ABC1234567890'))
      .mockResolvedValueOnce(text('C:23:DATA QUERY USERINFO'))
      .mockResolvedValueOnce(text('OK'));
    await runSimulator(options(['--scenario', 'poll', '--polls', '1', '--ack', ack]), {
      signal: new AbortController().signal,
      log: jest.fn(),
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(ack === 'none' ? 2 : 3);
    if (ack !== 'none')
      expect(Buffer.from(fetcher.mock.calls[2][1].body).toString()).toContain(
        `ID=23&Return=${ack === 'success' ? 0 : -1004}`,
      );
  });
  it('limits attendance mode to handshake and upload', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(text('GET OPTION FROM: ABC1234567890'))
      .mockResolvedValueOnce(text('OK: 1'));
    await runSimulator(options(['--scenario', 'attendance']), {
      signal: new AbortController().signal,
      log: jest.fn(),
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('polls sequentially and cancels the wait in watch mode', async () => {
    const stop = new AbortController();
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(text('GET OPTION FROM: ABC1234567890'))
      .mockResolvedValueOnce(text('OK'));
    let polled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      polled = resolve;
    });
    const running = runSimulator(options(['--scenario', 'poll', '--watch']), {
      signal: stop.signal,
      fetcher,
      log: (message) => {
        if (message.startsWith('POLL')) polled();
      },
    });
    await waiting;
    stop.abort();
    await expect(running).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
