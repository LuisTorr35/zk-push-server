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

describe('webhook configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://zk:zk@localhost/zk_push_test',
    API_KEY: 'key',
    PHOTO_STORAGE: '2',
  };
  it('accepts an empty pair and sets delivery defaults', () => {
    const config = validateEnv({ ...base, WEBHOOK_URL: '', WEBHOOK_SECRET: '' });
    expect(config.WEBHOOK_URL).toBeUndefined();
    expect(config.WEBHOOK_TIMEOUT_MS).toBe(10000);
    expect(config.WEBHOOK_POLL_INTERVAL_MS).toBe(1000);
    expect(config.WEBHOOK_MAX_ATTEMPTS).toBe(10);
  });
  it.each([
    { WEBHOOK_URL: 'https://example.com/webhook' },
    { WEBHOOK_SECRET: 'secret' },
    { WEBHOOK_URL: 'ftp://example.com/webhook', WEBHOOK_SECRET: 'secret' },
    { WEBHOOK_URL: 'https://user:pass@example.com/webhook', WEBHOOK_SECRET: 'secret' },
    { WEBHOOK_TIMEOUT_MS: '30001' },
    { WEBHOOK_TIMEOUT_MS: '0' },
    { WEBHOOK_MAX_ATTEMPTS: '101' },
    { WEBHOOK_MAX_ATTEMPTS: '0' },
    { WEBHOOK_POLL_INTERVAL_MS: '-1' },
  ])('rejects invalid configuration %j', (change) => {
    expect(() => validateEnv({ ...base, ...change })).toThrow();
  });
  it('accepts a complete HTTP(S) pair', () => {
    expect(
      validateEnv({
        ...base,
        WEBHOOK_URL: 'https://example.com/webhook',
        WEBHOOK_SECRET: 'secret',
      }).WEBHOOK_SECRET,
    ).toBe('secret');
  });
});
