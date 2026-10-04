import { z } from 'zod';

/**
 * Environment variables contract.
 *
 * Validated ONCE at startup: if something is missing or malformed the process
 * refuses to boot. Failing here is much better than finding out on the first
 * request a terminal makes at 6 in the morning.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  API_KEY: z.string().min(1),
  COMMAND_ACK_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(86400).default(60),

  // Empty values pause delivery and suppress creation of new events.
  WEBHOOK_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        );
      }, 'Expected an HTTP(S) URL without credentials')
      .optional(),
  ),
  WEBHOOK_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60000).default(1000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(30000).default(10000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(10),

  /** Numeric environment values become named modes for application services. */
  PHOTO_STORAGE: z
    .enum(['0', '1', '2'])
    .default('1')
    .transform((value) => (({ '0': 'both', '1': 's3', '2': 'db' }) as const)[value]),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment and returns the typed object consumed by
 * ConfigService. S3-backed modes require bucket credentials.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }

  const env = parsed.data;

  if (Boolean(env.WEBHOOK_URL) !== Boolean(env.WEBHOOK_SECRET)) {
    throw new Error('WEBHOOK_URL and WEBHOOK_SECRET must be configured together');
  }

  if (env.PHOTO_STORAGE !== 'db') {
    const missing = (
      ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const
    ).filter((key) => !env[key]);

    if (missing.length > 0) {
      throw new Error(
        `PHOTO_STORAGE=${env.PHOTO_STORAGE} requires: ${missing.join(', ')}`,
      );
    }
  }

  return env;
}

/** Standalone local tooling uses the same validated environment contract. */
export function loadEnvironment(): Env {
  return validateEnv(process.env);
}
