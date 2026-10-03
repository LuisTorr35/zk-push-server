export class DeviceDisabledError extends Error {
  constructor() {
    super('DEVICE DISABLED');
    this.name = 'DeviceDisabledError';
  }
}
