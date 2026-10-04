import { parseOptions, SimulatorError } from './options';

const now = new Date('2026-10-04T08:30:00Z');
describe('simulator CLI arguments', () => {
  it('uses synthetic defaults and freezes the generated wall clock', () => {
    expect(parseOptions([], now)).toEqual({
      help: false,
      options: {
        url: 'http://localhost:3000',
        sn: 'ABC1234567890',
        scenario: 'smoke',
        pin: '1001',
        repeat: 1,
        polls: 10,
        intervalMs: 1000,
        ack: 'success',
        returnCode: -1004,
        localTime: '2026-10-04 08:30:00',
        watch: false,
      },
    });
  });
  it('reports a malformed URL as an argument error', () => {
    expect(() => parseOptions(['--url', 'not-a-url'], now)).toThrow(SimulatorError);
    expect(() => parseOptions(['--url', 'not-a-url'], now)).toThrow(
      'Invalid options: url',
    );
  });
  it('supports help without server configuration', () => {
    expect(parseOptions(['--help'])).toEqual({ help: true });
    expect(parseOptions(['-h'])).toEqual({ help: true });
  });
  it('supports both forms of a negative error code', () => {
    for (const args of [['--return-code', '-2'], ['--return-code=-2']]) {
      const parsed = parseOptions(['--ack', 'error', ...args], now);
      expect(parsed.help).toBe(false);
      if (!parsed.help) expect(parsed.options.returnCode).toBe(-2);
    }
  });
  it('allows finite polling or continuous watch', () => {
    expect(parseOptions(['--scenario', 'poll', '--polls', '2'], now)).toMatchObject({
      options: { polls: 2, watch: false },
    });
    expect(parseOptions(['--scenario', 'poll', '--watch'], now)).toMatchObject({
      options: { watch: true },
    });
  });
  it('accepts leap-day timestamps and an ATTLOG file', () => {
    expect(
      parseOptions(['--local-time', '2024-02-29 23:59:59', '--file', 'batch.txt'], now),
    ).toMatchObject({ options: { file: 'batch.txt' } });
  });
  it.each([
    ['--unknown'],
    ['positional'],
    ['--sn', 'bad-serial'],
    ['--sn', 'A'.repeat(65)],
    ['--pin', 'bad pin'],
    ['--pin', 'A'.repeat(25)],
    ['--scenario', 'unknown'],
    ['--ack', 'unknown'],
    ['--repeat', '0'],
    ['--polls', '1.5'],
    ['--interval-ms', '2147483648'],
    ['--url', 'ftp://example.com'],
    ['--url', 'http://user:secret@example.com'],
    ['--url', 'http://example.com/prefix'],
    ['--url', 'http://example.com?secret=hidden'],
    ['--local-time', '2026-02-29 08:30:00'],
    ['--local-time', '2026-10-04 24:00:00'],
    ['--local-time', '2026-10-04 08:30:00\ninvalid'],
    ['--watch', '--polls', '10'],
    ['--watch', '--scenario', 'attendance'],
    ['--scenario', 'poll', '--file', 'batch.txt'],
    ['--return-code', '2'],
    ['--ack', 'error', '--return-code', '0'],
    ['--ack', 'error', '--return-code', '2147483648'],
  ])('rejects invalid arguments %j', (...args: string[]) => {
    expect(() => parseOptions(args, now)).toThrow();
  });
});
