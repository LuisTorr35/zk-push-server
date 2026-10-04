import { Injectable } from '@nestjs/common';
import { Prisma, type Person } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { NewPhoto } from '../../shared/storage/photo-storage';
import { PersonsError } from './persons.error';
import type {
  CreatePerson,
  UpdatePerson,
  ProfileAction,
  ProfileCommand,
} from './persons.types';

const photoMetadata = {
  id: true,
  mode: true,
  contentType: true,
  size: true,
  hash: true,
  createdAt: true,
} as const;
const personSelection = {
  id: true,
  pin: true,
  name: true,
  externalId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  photo: { select: photoMetadata },
} as const;
const operationSelection = {
  id: true,
  action: true,
  version: true,
  deviceSns: true,
  createdAt: true,
  commands: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      returnCode: true,
      failureReason: true,
      device: { select: { sn: true } },
    },
  },
} as const;

@Injectable()
export class PersonsRepository {
  constructor(private readonly prisma: PrismaService) {}
  find(pin: string) {
    return this.prisma.person.findUnique({ where: { pin }, select: personSelection });
  }
  async create(input: CreatePerson) {
    try {
      return await this.prisma.person.create({ data: input, select: personSelection });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new PersonsError('conflict', 'PIN already exists');
      throw error;
    }
  }
  update(pin: string, input: UpdatePerson) {
    return this.prisma.$transaction(async (tx) => {
      const person = await this.lockPerson(tx, pin);
      return tx.person.update({
        where: { id: person.id },
        data: { ...input, version: { increment: 1 } },
        select: personSelection,
      });
    });
  }
  attachPhoto(pin: string, photo: NewPhoto) {
    return this.prisma.$transaction(async (tx) => {
      const person = await this.lockPerson(tx, pin);
      await tx.photo.create({ data: photo });
      return tx.person.update({
        where: { id: person.id },
        data: { photoId: photo.id, version: { increment: 1 } },
        select: personSelection,
      });
    });
  }
  enqueue(
    pin: string,
    action: ProfileAction,
    deviceSns: string[],
    build: (person: Person) => ProfileCommand[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const person = await this.lockPerson(tx, pin);
      const devices = await tx.$queryRaw<{ id: number; sn: string; enabled: boolean }[]>`
        SELECT id, sn, enabled FROM "Device" WHERE sn IN (${Prisma.join(deviceSns)}) ORDER BY id FOR UPDATE
      `;
      if (devices.length !== deviceSns.length)
        throw new PersonsError('missing', 'Device not found');
      if (devices.some((device) => !device.enabled))
        throw new PersonsError('conflict', 'Device is disabled');
      const active = await tx.personOperation.findMany({
        where: {
          personId: person.id,
          commands: { some: { status: { in: ['pending', 'sent'] } } },
        },
        select: operationSelection,
      });
      for (const operation of active) {
        if (
          !operation.commands.some(
            (command) =>
              ['pending', 'sent'].includes(command.status) &&
              deviceSns.includes(command.device.sn),
          )
        )
          continue;
        if (
          operation.action === action &&
          operation.version === person.version &&
          JSON.stringify(operation.deviceSns) === JSON.stringify(deviceSns)
        )
          return operation;
        throw new PersonsError(
          'conflict',
          'An incompatible operation is still active for this person and device',
        );
      }
      const drafts = build(person);
      const operation = await tx.personOperation.create({
        data: { personId: person.id, action, version: person.version, deviceSns },
      });
      for (const device of devices) {
        let predecessorId: number | undefined;
        for (const draft of drafts) {
          const command = await tx.command.create({
            data: {
              deviceId: device.id,
              personId: person.id,
              operationId: operation.id,
              type: draft.type,
              payload: draft.payload,
              photoId: draft.photoId,
              predecessorId,
              dependencyMode: predecessorId ? draft.dependencyMode : undefined,
              profileSnapshot: {
                pin: person.pin,
                name: person.name,
                version: person.version,
              },
              dedupeKey: `${operation.id}:${draft.type}`,
            },
          });
          predecessorId = command.id;
        }
      }
      return tx.personOperation.findUniqueOrThrow({
        where: { id: operation.id },
        select: operationSelection,
      });
    });
  }
  operation(pin: string, id: string) {
    return this.prisma.personOperation.findFirst({
      where: { id, person: { pin } },
      select: operationSelection,
    });
  }
  private async lockPerson(tx: Prisma.TransactionClient, pin: string): Promise<Person> {
    const rows = await tx.$queryRaw<
      Person[]
    >`SELECT * FROM "Person" WHERE pin = ${pin} FOR UPDATE`;
    if (!rows[0]) throw new PersonsError('missing', 'Person not found');
    return rows[0];
  }
}
