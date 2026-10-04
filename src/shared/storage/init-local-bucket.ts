import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadEnvironment } from '../config/env.schema';

/** Compose-only initializer. Application requests never create external buckets. */
async function main(): Promise<void> {
  const config = loadEnvironment();
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY!,
      secretAccessKey: config.S3_SECRET_KEY!,
    },
    maxAttempts: 1,
  });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
        await client.send(new DeleteBucketPolicyCommand({ Bucket: config.S3_BUCKET }));
        console.log('Local photo bucket is ready');
        return;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) {
          try {
            await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
            await client.send(
              new DeleteBucketPolicyCommand({ Bucket: config.S3_BUCKET }),
            );
            console.log('Local photo bucket created with private access');
            return;
          } catch {
            /* The server may still be starting. */
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Local photo bucket initialization failed');
  } finally {
    client.destroy();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Bucket initialization failed');
  process.exitCode = 1;
});
