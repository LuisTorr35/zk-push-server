import { Injectable } from '@nestjs/common';
import { ImageProcessor } from '../../shared/storage/image-processor';
import { PhotoStorage } from '../../shared/storage/photo-storage';
import {
  encodeProfileDeletion,
  encodeUserInfo,
} from '../../protocol/iclock/profile-command.encoder';
import { PersonsRepository } from './persons.repository';
import { PersonsError } from './persons.error';
import type { CreatePerson, UpdatePerson, ProfileAction } from './persons.types';

@Injectable()
export class PersonsService {
  constructor(
    private readonly repository: PersonsRepository,
    private readonly images: ImageProcessor,
    private readonly storage: PhotoStorage,
  ) {}
  create(input: CreatePerson) {
    return this.repository.create(input);
  }
  async get(pin: string) {
    const person = await this.repository.find(pin);
    if (!person) throw new PersonsError('missing', 'Person not found');
    return person;
  }
  update(pin: string, input: UpdatePerson) {
    return this.repository.update(pin, input);
  }
  async uploadPhoto(pin: string, bytes: Buffer) {
    await this.get(pin);
    const normalized = await this.images.process(bytes);
    return this.storage.save(normalized, (photo) =>
      this.repository.attachPhoto(pin, photo),
    );
  }
  async readPhoto(pin: string) {
    const person = await this.get(pin);
    if (!person.photo) throw new PersonsError('missing', 'Person has no photo');
    return this.storage.read(person.photo.id);
  }
  enqueue(pin: string, action: ProfileAction, deviceSns: string[]) {
    return this.repository.enqueue(pin, action, [...deviceSns].sort(), (person) => {
      if (action === 'delete-profile')
        return encodeProfileDeletion(person.pin).map((command) => ({
          ...command,
          dependencyMode: 'finished',
        }));
      if (!person.photoId)
        throw new PersonsError('invalid', 'Enrollment requires a photo');
      return [
        { type: 'USERINFO', payload: encodeUserInfo(person) },
        {
          type: 'BIOPHOTO_UPLOAD',
          payload: null,
          photoId: person.photoId,
          dependencyMode: 'confirmed',
        },
      ];
    });
  }
  async operation(pin: string, id: string) {
    const operation = await this.repository.operation(pin, id);
    if (!operation) throw new PersonsError('missing', 'Operation not found');
    const active = operation.commands.some((command) =>
      ['pending', 'sent'].includes(command.status),
    );
    return {
      ...operation,
      status: active
        ? 'active'
        : operation.commands.every((command) => command.status === 'confirmed')
          ? 'confirmed'
          : 'failed',
    };
  }
}
