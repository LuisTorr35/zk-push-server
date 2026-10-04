import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/config/env.schema';
import { WebhookDispatcher } from './webhook-dispatcher.service';

@Injectable()
export class WebhookWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebhookWorker.name);
  private stopped = false;
  private running?: Promise<void>;
  private wake?: () => void;
  private readonly interval: number;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    config: ConfigService<Env, true>,
  ) {
    this.interval = config.get('WEBHOOK_POLL_INTERVAL_MS', { infer: true });
  }
  onApplicationBootstrap(): void {
    this.running = this.run();
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.dispatcher.dispatchOnce();
      } catch {
        this.logger.error('WEBHOOK reservation failed');
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, this.interval);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
  }
}
