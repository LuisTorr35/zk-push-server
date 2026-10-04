import { createHmac } from 'node:crypto';
import { retryDelay, webhookSignature } from './webhook-signature';

describe('webhook transport contract', () => {
  it('signs timestamp and the exact stored body bytes', () => {
    const body = '{ "id": "test", "name": "José" }';
    const signature = `sha256=${createHmac('sha256', 'secret').update(`1000.${body}`).digest('hex')}`;
    expect(webhookSignature('secret', '1000', body)).toBe(signature);
    expect(webhookSignature('secret', '1001', body)).not.toBe(signature);
    expect(webhookSignature('secret', '1000', JSON.stringify(JSON.parse(body)))).not.toBe(
      signature,
    );
  });
  it('backs off exponentially with bounded positive jitter and a one-hour cap', () => {
    expect(retryDelay(1, 0)).toBe(5000);
    expect(retryDelay(2, 0)).toBe(10000);
    expect(retryDelay(1, 1)).toBe(6000);
    expect(retryDelay(100, 1)).toBe(3600000);
  });
});
