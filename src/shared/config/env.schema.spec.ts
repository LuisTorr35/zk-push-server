import { validateEnv } from './env.schema';

describe('command timeout configuration', () => {
  const config = {
    DATABASE_URL: 'postgresql://zk:zk@localhost/zk_push_test',
    API_KEY: 'test-key',
    PHOTO_STORAGE: '2',
  };
  it('uses sixty seconds by default', () => {
    expect(validateEnv(config).COMMAND_ACK_TIMEOUT_SECONDS).toBe(60);
  });
  it('coerces a positive integer string', () => {
    expect(
      validateEnv({ ...config, COMMAND_ACK_TIMEOUT_SECONDS: '120' })
        .COMMAND_ACK_TIMEOUT_SECONDS,
    ).toBe(120);
  });
  it.each(['0', '-1', '1.5', 'bad', '86401'])('rejects invalid timeout %s', (timeout) => {
    expect(() =>
      validateEnv({ ...config, COMMAND_ACK_TIMEOUT_SECONDS: timeout }),
    ).toThrow('Invalid environment variables');
  });
});

describe('photo storage and API configuration', () => {
  const config = {
    DATABASE_URL: 'postgresql://zk:zk@localhost/zk_push_test',
    API_KEY: 'test-key',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'secret',
  };
  it('defaults to S3 and normalizes numeric modes', () => {
    expect(validateEnv(config).PHOTO_STORAGE).toBe('s3');
    expect(validateEnv({ ...config, PHOTO_STORAGE: '0' }).PHOTO_STORAGE).toBe('both');
    expect(validateEnv({ ...config, PHOTO_STORAGE: '2' }).PHOTO_STORAGE).toBe('db');
  });
  it.each(['3', '-1', 'db', 's3', ''])('rejects invalid mode %s', (value) => {
    expect(() => validateEnv({ ...config, PHOTO_STORAGE: value })).toThrow();
  });
  it.each(['0', '1'])('requires S3 credentials in mode %s', (mode) => {
    expect(() =>
      validateEnv({ ...config, PHOTO_STORAGE: mode, S3_SECRET_KEY: undefined }),
    ).toThrow('requires');
  });
  it('database-only mode requires no S3 configuration', () => {
    expect(
      validateEnv({
        DATABASE_URL: config.DATABASE_URL,
        API_KEY: 'key',
        PHOTO_STORAGE: '2',
      }).PHOTO_STORAGE,
    ).toBe('db');
  });
  it('requires an API key', () => {
    expect(() => validateEnv({ ...config, API_KEY: undefined })).toThrow('API_KEY');
  });
});
