import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { InvalidPhotoError } from './photo-storage.error';

export const MAX_PHOTO_BYTES = 150 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Injectable()
export class ImageProcessor {
  async process(input: Buffer): Promise<Buffer> {
    if (!input.length || input.length > MAX_UPLOAD_BYTES) {
      throw new InvalidPhotoError('Photo must contain at most 10 MiB');
    }
    try {
      const metadata = await sharp(input).metadata();
      if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
        throw new InvalidPhotoError('Photo must be a single JPEG or PNG image');
      }
      for (const dimension of [600, 480, 360]) {
        for (const quality of [80, 70, 60, 50, 40]) {
          const result = await sharp(input)
            .rotate()
            .resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality })
            .toBuffer();
          if (result.length <= MAX_PHOTO_BYTES) return result;
        }
      }
      throw new InvalidPhotoError('Photo cannot be compressed below 150 KiB');
    } catch (error) {
      if (error instanceof InvalidPhotoError) throw error;
      throw new InvalidPhotoError('Invalid image data');
    }
  }
}
