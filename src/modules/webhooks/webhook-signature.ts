import { createHmac } from 'node:crypto';

export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Positive jitter spreads retries while keeping the delay at or below one hour. */
export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.min(3600000, 5000 * 2 ** Math.min(attempt - 1, 10) * (1 + random * 0.2));
}
