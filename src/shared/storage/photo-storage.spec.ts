import { PhotoStorage } from './photo-storage';
import {
  BothPhotoStorage,
  DatabasePhotoStorage,
  type PhotoBackend,
  S3PhotoStorage,
} from './photo-backends';
import { PhotosRepository } from './photos.repository';

describe('PhotoStorage compensation', () => {
  it('removes the uploaded object if the database transaction fails', async () => {
    const location = {
      mode: 's3' as const,
      s3Key: 'photos/test.jpg',
      s3Bucket: 'test',
      bytes: null,
    };
    const backend: PhotoBackend = {
      save: jest.fn().mockResolvedValue(location),
      read: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const storage = new PhotoStorage(
      backend,
      {} as DatabasePhotoStorage,
      {} as S3PhotoStorage,
      {} as BothPhotoStorage,
      {} as PhotosRepository,
    );
    const persist = jest.fn().mockRejectedValue(new Error('Transaction failed'));
    await expect(storage.save(Buffer.from('bytes'), persist)).rejects.toThrow(
      'Transaction failed',
    );
    expect(backend.delete).toHaveBeenCalledWith(location);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        ...location,
        size: 5,
        contentType: 'image/jpeg',
        hash: expect.any(String),
      }),
    );
  });
  it('does not confirm a write if S3 fails before persistence', async () => {
    const backend: PhotoBackend = {
      save: jest.fn().mockRejectedValue(new Error('Unavailable')),
      read: jest.fn(),
      delete: jest.fn(),
    };
    const storage = new PhotoStorage(
      backend,
      {} as DatabasePhotoStorage,
      {} as S3PhotoStorage,
      {} as BothPhotoStorage,
      {} as PhotosRepository,
    );
    const persist = jest.fn();
    await expect(storage.save(Buffer.from('bytes'), persist)).rejects.toThrow(
      'Unavailable',
    );
    expect(persist).not.toHaveBeenCalled();
  });
});
