import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/config/env.schema';
import { WebhookDispatcher } from './webhook-dispatcher.service';
import { WebhookWorker } from './webhook-worker.service';

describe('webhook worker shutdown', () => {
  it('waits for an active batch and starts no more reservations', async () => {
    let finish!: (count: number) => void;
    const dispatchOnce = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new WebhookWorker(
      { dispatchOnce } as unknown as WebhookDispatcher,
      new ConfigService<Env, true>({ WEBHOOK_POLL_INTERVAL_MS: 1000 }),
    );
    worker.onApplicationBootstrap();
    let stopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(dispatchOnce).toHaveBeenCalledTimes(1);
  });
});
