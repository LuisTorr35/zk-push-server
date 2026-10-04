import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Photo } from '@prisma/client';
import {
  BothPhotoStorage,
  DatabasePhotoStorage,
  PHOTO_BACKEND,
  S3PhotoStorage,
  type PhotoBackend,
  type PhotoLocation,
} from './photo-backends';
import { PhotosRepository } from './photos.repository';
import { PhotoStorageError } from './photo-storage.error';

export type NewPhoto = PhotoLocation &
  Pick<Photo, 'id' | 'contentType' | 'size' | 'hash'>;

@Injectable()
export class PhotoStorage {
  private readonly logger = new Logger(PhotoStorage.name);
  constructor(
    @Inject(PHOTO_BACKEND) private readonly writer: PhotoBackend,
    private readonly db: DatabasePhotoStorage,
    private readonly s3: S3PhotoStorage,
    private readonly both: BothPhotoStorage,
    private readonly repository: PhotosRepository,
  ) {}
  async save<T>(bytes: Buffer, persist: (photo: NewPhoto) => Promise<T>): Promise<T> {
    const id = randomUUID();
    const location = await this.writer.save(id, bytes);
    try {
      return await persist({
        ...location,
        id,
        contentType: 'image/jpeg',
        size: bytes.length,
        hash: this.hash(bytes),
      });
    } catch (error) {
      try {
        await this.writer.delete(location);
      } catch {
        this.logger.error(`PHOTO id=${id} cleanup failed`);
      }
      throw error;
    }
  }
  async read(id: string): Promise<Buffer> {
    const photo = await this.repository.find(id);
    if (!photo) throw new PhotoStorageError(true);
    const backend = { db: this.db, s3: this.s3, both: this.both }[photo.mode];
    let bytes = await backend.read(photo);
    if (bytes.length !== photo.size || this.hash(bytes) !== photo.hash) {
      if (photo.mode === 'both') bytes = await this.db.read(photo);
      if (bytes.length !== photo.size || this.hash(bytes) !== photo.hash)
        throw new PhotoStorageError(true);
    }
    return bytes;
  }
  private hash(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
