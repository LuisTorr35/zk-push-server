export class PhotoStorageError extends Error {
  constructor(public readonly permanent = false) {
    super(
      permanent ? 'Photo is unavailable' : 'Photo storage is temporarily unavailable',
    );
  }
}

export class InvalidPhotoError extends Error {}
