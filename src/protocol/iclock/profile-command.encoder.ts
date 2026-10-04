import type { ProfileSnapshot } from '../../modules/persons/persons.types';

export function encodeUserInfo(profile: ProfileSnapshot): string {
  const fields: Record<string, string> = {
    PIN: profile.pin,
    Name: profile.name,
    Pri: '0',
    Passwd: '',
    Card: '',
    Grp: '1',
    TZ: '0000000100000000',
    Verify: '-1',
  };
  return `DATA UPDATE USERINFO\t${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join('\t')}`;
}

export function encodeBioPhoto(pin: string, bytes: Buffer): string {
  return `DATA UPDATE BIOPHOTO\tPIN=${pin}\tFileName=${pin}.jpg\tType=9\tSize=${bytes.length}\tContent=${bytes.toString('base64')}`;
}

export function encodeProfileDeletion(pin: string): { type: string; payload: string }[] {
  return [
    ...[9, 2, 1].map((type) => ({
      type: `DELETE_BIODATA_${type}`,
      payload: `DATA DELETE biodata Pin=${pin}\tType=${type}`,
    })),
    { type: 'DELETE_BIOPHOTO', payload: `DATA DELETE biophoto PIN=${pin}` },
    { type: 'DELETE_USERINFO', payload: `DATA DELETE USERINFO PIN=${pin}` },
  ];
}
