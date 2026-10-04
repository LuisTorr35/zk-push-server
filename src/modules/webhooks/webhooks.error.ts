export class WebhooksError extends Error {
  constructor(
    readonly kind: 'invalid' | 'missing' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
