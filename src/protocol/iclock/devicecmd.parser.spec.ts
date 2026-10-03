import { parseDevicecmd } from './devicecmd.parser';

describe('parseDevicecmd', () => {
  it('parses batches with optional CMD and negative return codes', () => {
    expect(parseDevicecmd('ID=12&Return=0&CMD=DATA\r\n\r\nReturn=-1004&ID=13\n')).toEqual(
      {
        records: [
          { id: 12, returnCode: 0 },
          { id: 13, returnCode: -1004 },
        ],
        rejected: 0,
      },
    );
  });
  it.each([
    'ID=1',
    'Return=0',
    'ID=0&Return=0',
    'ID=-1&Return=0',
    'ID=1.5&Return=0',
    'ID=2147483648&Return=0',
    'ID=1&Return=',
    'ID=1&Return=1e2',
    'ID=1&Return=-2147483649',
    'ID=1&ID=2&Return=0',
    'ID=1&Return=0&Return=-1',
    'broken',
  ])('rejects invalid result %s', (line) => {
    expect(parseDevicecmd(line)).toEqual({ records: [], rejected: 1 });
  });
  it('keeps valid rows from a mixed batch', () => {
    expect(parseDevicecmd('broken\nID=1&Return=0')).toEqual({
      records: [{ id: 1, returnCode: 0 }],
      rejected: 1,
    });
  });
  it('accepts signed int32 boundaries and an empty body', () => {
    expect(parseDevicecmd('ID=1&Return=-2147483648').rejected).toBe(0);
    expect(parseDevicecmd('ID=1&Return=2147483647').rejected).toBe(0);
    expect(parseDevicecmd('')).toEqual({ records: [], rejected: 0 });
  });
});
