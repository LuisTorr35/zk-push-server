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
  COMMAND_ACK_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(86400).default(60),

  /** Where photos are stored: in the database or in an S3 bucket. */
  PHOTO_STORAGE: z.enum(['db', 's3']).default('db'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment and returns the typed object consumed by
 * ConfigService. When PHOTO_STORAGE is "s3" the bucket credentials become
 * required as well.
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

  if (env.PHOTO_STORAGE === 's3') {
    const missing = (
      ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const
    ).filter((key) => !env[key]);

    if (missing.length > 0) {
      throw new Error(`PHOTO_STORAGE=s3 requires: ${missing.join(', ')}`);
    }
  }

  return env;
}
