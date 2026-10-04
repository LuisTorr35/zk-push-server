import { parseArgs } from 'node:util';
import { z } from 'zod';
import { parseAttlog } from '../../src/protocol/iclock/attlog.parser';

export class SimulatorError extends Error {}
const positiveInteger = z.coerce.number().int().positive().max(2147483647);
const schema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, 'Expected an HTTP(S) origin without credentials, path, query or fragment')
    .default('http://localhost:3000'),
  sn: z
    .string()
    .regex(/^[A-Za-z0-9]{1,64}$/)
    .default('ABC1234567890'),
  scenario: z.enum(['smoke', 'attendance', 'poll']).default('smoke'),
  pin: z
    .string()
    .regex(/^[A-Za-z0-9]{1,24}$/)
    .default('1001'),
  repeat: positiveInteger.default(1),
  polls: positiveInteger.default(10),
  intervalMs: positiveInteger.default(1000),
  ack: z.enum(['success', 'error', 'none']).default('success'),
  returnCode: z.coerce
    .number()
    .int()
    .min(-2147483648)
    .max(2147483647)
    .refine((value) => value !== 0)
    .default(-1004),
  localTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    .refine(
      (value) => parseAttlog(`1001\t${value}\t0\t15`).records.length === 1,
      'Expected a valid YYYY-MM-DD HH:mm:ss timestamp',
    ),
  file: z.string().min(1).optional(),
  watch: z.boolean().default(false),
});
export type SimulatorOptions = z.infer<typeof schema>;
export type ParsedArguments = { help: true } | { help: false; options: SimulatorOptions };

export function parseOptions(args: string[], now = new Date()): ParsedArguments {
  // parseArgs otherwise treats a separate negative return code as another option.
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--return-code' && /^-\d+$/.test(args[i + 1] ?? '')) {
      normalized.push(`--return-code=${args[++i]}`);
    } else normalized.push(args[i]);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: normalized,
      strict: true,
      allowPositionals: false,
      options: {
        url: { type: 'string' },
        sn: { type: 'string' },
        scenario: { type: 'string' },
        pin: { type: 'string' },
        repeat: { type: 'string' },
        polls: { type: 'string' },
        'interval-ms': { type: 'string' },
        ack: { type: 'string' },
        'return-code': { type: 'string' },
        'local-time': { type: 'string' },
        file: { type: 'string' },
        watch: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch {
    throw new SimulatorError('Invalid arguments. Use --help for available options.');
  }
  if (values.help) return { help: true };
  if (values.watch && values.polls !== undefined)
    throw new SimulatorError('--watch and --polls cannot be combined');
  if (values.watch && values.scenario === 'attendance')
    throw new SimulatorError('--watch requires a polling scenario');
  if (values['return-code'] !== undefined && values.ack !== 'error')
    throw new SimulatorError('--return-code requires --ack error');
  if (values.file && values.scenario === 'poll')
    throw new SimulatorError('--file requires an attendance scenario');
  const parsed = schema.safeParse({
    url: values.url,
    sn: values.sn,
    scenario: values.scenario,
    pin: values.pin,
    repeat: values.repeat,
    polls: values.polls,
    intervalMs: values['interval-ms'],
    ack: values.ack,
    returnCode: values['return-code'],
    localTime: values['local-time'] ?? now.toISOString().slice(0, 19).replace('T', ' '),
    file: values.file,
    watch: values.watch,
  });
  if (!parsed.success) {
    throw new SimulatorError(
      `Invalid options: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}. Use --help.`,
    );
  }
  return { help: false, options: parsed.data };
}

export const HELP = `ZK terminal simulator (Node 22)
Usage: npm run simulate -- [options]

  --url <origin>          Server HTTP(S) origin (default: http://localhost:3000)
  --sn <serial>           Synthetic terminal serial (default: ABC1234567890)
  --scenario <name>       smoke | attendance | poll (default: smoke)
  --pin <pin>             Generated attendance PIN (default: 1001)
  --local-time <time>     YYYY-MM-DD HH:mm:ss; default: current UTC clock components
  --file <path>           Raw ATTLOG file, replacing the generated row; bytes preserved
  --repeat <count>        Send the same attendance batch this many times (default: 1)
  --polls <count>         Finite number of polls (default: 10)
  --interval-ms <ms>      Delay between sequential polls (default: 1000)
  --watch                Poll until Ctrl+C; cannot be combined with --polls
  --ack <mode>           success | error | none (default: success)
  --return-code <code>   Nonzero signed 32-bit code for --ack error (default: -1004)
  --help, -h             Show this help

Examples:
  npm run simulate -- --scenario smoke --repeat 2
  npm run simulate -- --scenario attendance --file test/fixtures/iclock/attlog-basic.txt
  npm run simulate -- --scenario poll --watch
  npm run simulate -- --scenario poll --ack error --return-code=-1004 --polls 6
  npm run simulate -- --scenario poll --ack none --watch

ACKs are simulated results; users/photos and facial recognition are not emulated.
Requests time out after 10 seconds. Exit: 0 completed/interrupted, 1 failed.
`;
