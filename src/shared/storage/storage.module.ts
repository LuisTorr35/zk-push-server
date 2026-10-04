import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  BothPhotoStorage,
  DatabasePhotoStorage,
  PHOTO_BACKEND,
  S3PhotoStorage,
} from './photo-backends';
import { PhotoStorage } from './photo-storage';
import { PhotosRepository } from './photos.repository';
import { ImageProcessor } from './image-processor';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    DatabasePhotoStorage,
    S3PhotoStorage,
    BothPhotoStorage,
    PhotoStorage,
    PhotosRepository,
    ImageProcessor,
    {
      provide: PHOTO_BACKEND,
      inject: [ConfigService, DatabasePhotoStorage, S3PhotoStorage, BothPhotoStorage],
      useFactory: (
        config: ConfigService<Env, true>,
        db: DatabasePhotoStorage,
        s3: S3PhotoStorage,
        both: BothPhotoStorage,
      ) => ({ db, s3, both })[config.get('PHOTO_STORAGE', { infer: true })],
    },
  ],
  exports: [PhotoStorage, ImageProcessor],
})
export class StorageModule {}
