import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookDelivery } from '@prisma/client';
import type { Env } from '../../shared/config/env.schema';
import { WebhooksRepository, type DeliveryResult } from './webhooks.repository';
import { retryDelay, webhookSignature } from './webhook-signature';

@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly timeout: number;

  constructor(
    private readonly repository: WebhooksRepository,
    config: ConfigService<Env, true>,
  ) {
    this.url = config.get('WEBHOOK_URL', { infer: true });
    this.secret = config.get('WEBHOOK_SECRET', { infer: true });
    this.timeout = config.get('WEBHOOK_TIMEOUT_MS', { infer: true });
  }

  async dispatchOnce(): Promise<number> {
    // Disabled workers leave pending deliveries and attempt budgets untouched.
    if (!this.url || !this.secret) return 0;
    const deliveries = await this.repository.reserve();
    const results = await Promise.allSettled(
      deliveries.map((delivery) => this.deliver(delivery)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        // A database failure leaves the lease recoverable; the receiver may already have committed.
        this.logger.error(
          `WEBHOOK id=${deliveries[i].id} attempt=${deliveries[i].attempts} error=persistence`,
        );
      }
    }
    return deliveries.length;
  }

  private async deliver(delivery: WebhookDelivery): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let result: DeliveryResult;
    try {
      const response = await fetch(this.url!, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-ZK-Event-Id': delivery.id,
          'X-ZK-Timestamp': timestamp,
          'X-ZK-Signature': webhookSignature(this.secret!, timestamp, delivery.body),
        },
        body: delivery.body,
      });
      result = { httpCode: response.status, error: response.ok ? null : 'http' };
      // Receiver response bodies are neither stored nor logged.
      await response.body?.cancel().catch(() => undefined);
    } catch {
      result = { httpCode: null, error: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
    const next = new Date(Date.now() + retryDelay(delivery.attempts));
    const saved = await this.repository.finish(delivery, result, next);
    let state = 'stale';
    if (saved) {
      state = result.error === null ? 'delivered' : 'pending';
      if (result.error !== null && delivery.attempts >= delivery.maxAttempts)
        state = 'failed';
    }
    this.logger.log(
      `WEBHOOK id=${delivery.id} attempt=${delivery.attempts} state=${state} http=${result.httpCode ?? '-'} error=${result.error ?? '-'}`,
    );
  }
}
