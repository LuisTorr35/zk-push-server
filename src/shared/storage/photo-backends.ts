import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Photo } from '@prisma/client';
import type { Env } from '../config/env.schema';
import { PhotoStorageError } from './photo-storage.error';

export type PhotoLocation = Pick<Photo, 'mode' | 's3Bucket' | 's3Key' | 'bytes'>;
export interface PhotoBackend {
  save(id: string, bytes: Buffer): Promise<PhotoLocation>;
  read(photo: Photo): Promise<Buffer>;
  delete(photo: PhotoLocation): Promise<void>;
}
export const PHOTO_BACKEND = Symbol('PHOTO_BACKEND');

@Injectable()
export class DatabasePhotoStorage implements PhotoBackend {
  // The photo bytes and person reference are committed by the caller's transaction.
  async save(_id: string, bytes: Buffer): Promise<PhotoLocation> {
    return { mode: 'db', bytes: new Uint8Array(bytes), s3Bucket: null, s3Key: null };
  }
  async read(photo: Photo): Promise<Buffer> {
    if (!photo.bytes) throw new PhotoStorageError(true);
    return Buffer.from(photo.bytes);
  }
  async delete(_photo: PhotoLocation): Promise<void> {
    // Database copies follow the transaction that owns the photo row.
  }
}

@Injectable()
export class S3PhotoStorage implements PhotoBackend, OnModuleDestroy {
  private readonly logger = new Logger(S3PhotoStorage.name);
  private readonly client: S3Client;
  constructor(private readonly config: ConfigService<Env, true>) {
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }) ?? '',
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }) ?? '',
      },
    });
  }
  async save(id: string, bytes: Buffer): Promise<PhotoLocation> {
    const s3Bucket = this.config.get('S3_BUCKET', { infer: true })!;
    const s3Key = `photos/${id}.jpg`;
    const location: PhotoLocation = { mode: 's3', bytes: null, s3Bucket, s3Key };
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
          Body: bytes,
          ContentType: 'image/jpeg',
        }),
      );
      return location;
    } catch {
      // A failed request can still have reached S3; cleanup also covers that case.
      await this.delete(location).catch(() =>
        this.logger.error(`PHOTO id=${id} cleanup failed`),
      );
      throw new PhotoStorageError();
    }
  }
  async read(photo: Photo): Promise<Buffer> {
    if (!photo.s3Bucket || !photo.s3Key) throw new PhotoStorageError(true);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: photo.s3Bucket, Key: photo.s3Key }),
      );
      if (!result.Body) throw new PhotoStorageError(true);
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof PhotoStorageError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new PhotoStorageError(name === 'NoSuchKey');
    }
  }
  async delete(photo: PhotoLocation): Promise<void> {
    if (!photo.s3Bucket || !photo.s3Key) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: photo.s3Bucket, Key: photo.s3Key }),
      );
    } catch {
      throw new PhotoStorageError();
    }
  }
  onModuleDestroy(): void {
    this.client.destroy();
  }
}

@Injectable()
export class BothPhotoStorage implements PhotoBackend {
  private readonly logger = new Logger(BothPhotoStorage.name);
  constructor(
    private readonly s3: S3PhotoStorage,
    private readonly db: DatabasePhotoStorage,
  ) {}
  async save(id: string, bytes: Buffer): Promise<PhotoLocation> {
    return {
      ...(await this.s3.save(id, bytes)),
      bytes: new Uint8Array(bytes),
      mode: 'both',
    };
  }
  async read(photo: Photo): Promise<Buffer> {
    try {
      return await this.s3.read(photo);
    } catch (error) {
      if (!photo.bytes) throw error;
      this.logger.warn(`PHOTO id=${photo.id} reading database copy`);
      return this.db.read(photo);
    }
  }
  delete(photo: PhotoLocation): Promise<void> {
    return this.s3.delete(photo);
  }
}
