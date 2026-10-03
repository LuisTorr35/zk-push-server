import { validateEnv } from './env.schema';

describe('command timeout configuration', () => {
  const config = { DATABASE_URL: 'postgresql://zk:zk@localhost/zk_push_test' };
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
