import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAttlog } from './attlog.parser';

// Reads a fixture byte for byte (tabs and \r\n included)
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../../test/fixtures/iclock', name), 'utf8');

describe('parseAttlog', () => {
  it('parses a normal batch', () => {
    const result = parseAttlog(fixture('attlog-basic.txt'));

    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      pin: '1001',
      localTime: '2026-09-25 08:03:12',
      status: 0,
      verifyType: 15,
    });
    expect(result.records[2].status).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('handles CRLF line endings', () => {
    const result = parseAttlog(fixture('attlog-crlf.txt'));

    expect(result.records).toHaveLength(2);
    expect(result.records[1].raw.endsWith('\r')).toBe(false);
    expect(result.rejected).toHaveLength(0);
  });

  it('skips broken lines and keeps the good ones', () => {
    const result = parseAttlog(fixture('attlog-malformed.txt'));

    expect(result.records.map((r) => r.pin)).toEqual(['1001', '1004']);
    // The empty line is skipped, not rejected
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'bad time format',
      'invalid date',
      'invalid pin',
    ]);
  });

  it('tolerates extra columns from newer firmware', () => {
    const result = parseAttlog(fixture('attlog-extra-fields.txt'));

    expect(result.records).toHaveLength(2);
    expect(result.records[0].raw).toContain('36.5');
  });

  it('parses the column layout seen on real devices (10 and 11 columns)', () => {
    const result = parseAttlog(fixture('attlog-real-shape.txt'));

    expect(result.records).toHaveLength(4);
    expect(result.records[3]).toMatchObject({ pin: '1001', status: 1, verifyType: 15 });
    expect(result.rejected).toHaveLength(0);
  });

  it('returns empty lists for an empty body', () => {
    expect(parseAttlog('')).toEqual({ records: [], rejected: [] });
  });
});
