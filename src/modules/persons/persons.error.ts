export class PersonsError extends Error {
  constructor(
    public readonly kind: 'invalid' | 'missing' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
