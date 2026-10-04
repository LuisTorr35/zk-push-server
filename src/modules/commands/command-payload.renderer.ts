import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PhotoStorage } from '../../shared/storage/photo-storage';
import { PhotoStorageError } from '../../shared/storage/photo-storage.error';
import { MAX_PHOTO_BYTES } from '../../shared/storage/image-processor';
import { encodeBioPhoto } from '../../protocol/iclock/profile-command.encoder';
import type { CommandRecord } from './commands.types';

@Injectable()
export class CommandPayloadRenderer {
  constructor(private readonly photos: PhotoStorage) {}
  async render(command: CommandRecord): Promise<string> {
    if (command.type !== 'BIOPHOTO_UPLOAD') {
      if (!command.payload) throw new PhotoStorageError(true);
      return command.payload;
    }
    const snapshot = z
      .object({ pin: z.string().regex(/^[A-Za-z0-9]{1,24}$/) })
      .safeParse(command.profileSnapshot);
    if (!snapshot.success || !command.photoId) throw new PhotoStorageError(true);
    const bytes = await this.photos.read(command.photoId);
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES)
      throw new PhotoStorageError(true);
    return encodeBioPhoto(snapshot.data.pin, bytes);
  }
}
