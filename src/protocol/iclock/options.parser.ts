import type { DeviceMetadata } from '../../modules/devices/devices.types';

/** OPTIONS uses key=value pairs separated by newlines or commas. */
export function parseOptions(body: string): DeviceMetadata {
  const fields: Record<string, string> = {};
  for (const token of body.split(/[\r\n,]+/)) {
    const equals = token.indexOf('=');
    if (equals <= 0) continue;
    const key = token.slice(0, equals).trim();
    const value = token.slice(equals + 1).trim();
    if (key && value) fields[key] = value;
  }

  const metadata: DeviceMetadata = {};
  const model = fields['~DeviceName'] || fields.DeviceName;
  if (model) metadata.model = model;
  if (fields.FWVersion) metadata.firmware = fields.FWVersion;
  for (const [key, target] of [
    ['UserCount', 'userCount'],
    ['FaceCount', 'faceCount'],
  ] as const) {
    const value = fields[key];
    if (
      value !== undefined &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) <= 2147483647
    ) {
      metadata[target] = Number(value);
    }
  }
  return metadata;
}
