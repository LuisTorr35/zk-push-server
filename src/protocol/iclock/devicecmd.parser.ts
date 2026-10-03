import type { CommandResponse } from '../../modules/commands/commands.types';

/** Device command results are ampersand-separated key=value lines. */
export function parseDevicecmd(body: string): {
  records: CommandResponse[];
  rejected: number;
} {
  const records: CommandResponse[] = [];
  let rejected = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = new Map<string, string>();
    let duplicate = false;
    for (const token of line.split('&')) {
      const equals = token.indexOf('=');
      if (equals <= 0) continue;
      const key = token.slice(0, equals);
      if (fields.has(key)) duplicate = true;
      fields.set(key, token.slice(equals + 1));
    }
    const id = fields.get('ID') ?? '';
    const code = fields.get('Return') ?? '';
    if (
      duplicate ||
      !/^\d+$/.test(id) ||
      !/^-?\d+$/.test(code) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) < 1 ||
      Number(id) > 2147483647 ||
      !Number.isSafeInteger(Number(code)) ||
      Number(code) < -2147483648 ||
      Number(code) > 2147483647
    ) {
      rejected++;
      continue;
    }
    records.push({ id: Number(id), returnCode: Number(code) });
  }
  return { records, rejected };
}
