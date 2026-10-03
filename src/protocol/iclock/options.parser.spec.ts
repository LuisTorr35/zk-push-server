import { parseOptions } from './options.parser';

describe('parseOptions', () => {
  it('parses newline and comma separated fields', () => {
    expect(
      parseOptions(
        '~DeviceName=Example Device,FWVersion=1.0\r\nUserCount=0\nFaceCount=12',
      ),
    ).toEqual({
      model: 'Example Device',
      firmware: '1.0',
      userCount: 0,
      faceCount: 12,
    });
  });

  it('supports DeviceName and preserves values containing equals', () => {
    expect(parseOptions('DeviceName=Example Device\nFWVersion=build=1')).toEqual({
      model: 'Example Device',
      firmware: 'build=1',
    });
  });

  it.each(['', ' ', '-1', '1.5', '1e2', '2147483648', 'bad'])(
    'omits invalid counters %j without dropping valid fields',
    (value) => {
      expect(parseOptions(`UserCount=${value},FaceCount=${value},FWVersion=1.0`)).toEqual(
        { firmware: '1.0' },
      );
    },
  );

  it('ignores unknown, empty and malformed fields', () => {
    expect(parseOptions('FWVersion=\nUserCount=\nIPAddress=192.0.2.1\nbroken')).toEqual(
      {},
    );
  });
});
