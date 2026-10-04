import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { configureBodyParsers } from '../src/shared/http/body-parsers';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PhotoStorage } from '../src/shared/storage/photo-storage';
import {
  BothPhotoStorage,
  DatabasePhotoStorage,
  PHOTO_BACKEND,
  S3PhotoStorage,
} from '../src/shared/storage/photo-backends';
import { PhotoStorageError } from '../src/shared/storage/photo-storage.error';
import { CommandsService } from '../src/modules/commands/commands.service';
import { PersonsRepository } from '../src/modules/persons/persons.repository';

type PersonResponse = { photo: { id: string; bytes?: unknown; s3Key?: unknown } };

type Operation = { id: string; commands: { id: number; type: string }[] };

async function createApp(mode: 's3' | 'db' | 'both'): Promise<NestExpressApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PHOTO_BACKEND)
    .useFactory({
      inject: [DatabasePhotoStorage, S3PhotoStorage, BothPhotoStorage],
      factory: (db: DatabasePhotoStorage, s3: S3PhotoStorage, both: BothPhotoStorage) =>
        ({ db, s3, both })[mode],
    })
    .compile();
  assert.equal(
    new URL(module.get(ConfigService).getOrThrow<string>('DATABASE_URL')).pathname,
    '/zk_push_test',
    'Integration tests require zk_push_test',
  );
  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  configureBodyParsers(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

async function main(): Promise<void> {
  let app = await createApp('db');
  let prisma = app.get(PrismaService);
  let baseUrl = await app.getUrl();
  const key = app.get(ConfigService).getOrThrow<string>('API_KEY');
  const prefix = `T${randomUUID().replace(/-/g, '').slice(0, 15)}`;
  const pins: string[] = [];
  const deviceIds: number[] = [];
  const photoIds: string[] = [];
  const jpeg = await sharp({
    create: { width: 800, height: 1000, channels: 3, background: '#445566' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const png = await sharp({
    create: { width: 150, height: 200, channels: 4, background: '#aa3311ff' },
  })
    .png()
    .toBuffer();
  const request = async <T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
  ) => {
    const response = await fetch(`${baseUrl}/api/persons${path}`, {
      method,
      headers: {
        'X-API-Key': key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(
      response.status,
      status,
      `Unexpected status for ${method} ${path}: ${await response.clone().text()}`,
    );
    return (await response.json()) as T;
  };
  const upload = async (pin: string, image = jpeg, status = 200) => {
    const form = new FormData();
    form.set(
      'photo',
      new Blob([new Uint8Array(image)], { type: 'application/octet-stream' }),
      'photo.bin',
    );
    const response = await fetch(`${baseUrl}/api/persons/${pin}/photo`, {
      method: 'PUT',
      headers: { 'X-API-Key': key },
      body: form,
    });
    assert.equal(response.status, status, await response.clone().text());
    const result = (await response.json()) as PersonResponse;
    if (status === 200) photoIds.push(result.photo.id);
    return result;
  };
  const createPerson = async (suffix: string) => {
    const pin = `${prefix}${suffix}`;
    pins.push(pin);
    await request('', 'POST', { pin, name: 'Example Person' }, 201);
    return pin;
  };
  const device = async (suffix: string, enabled = true) => {
    const row = await prisma.device.create({
      data: { sn: `${prefix}${suffix}`, name: 'Example Terminal', enabled },
    });
    deviceIds.push(row.id);
    return row;
  };
  const poll = async (sn: string) => {
    const response = await fetch(`${baseUrl}/iclock/getrequest?SN=${sn}`);
    assert.equal(response.status, 200);
    return response.text();
  };
  const ack = async (sn: string, body: string, returnCode = 0) => {
    const id = Number(/^C:(\d+):/.exec(body)![1]);
    const response = await fetch(`${baseUrl}/iclock/devicecmd?SN=${sn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `ID=${id}&Return=${returnCode}`,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
  };
  try {
    // Real writes and reads in all three modes; old photos survive mode changes.
    const saved: { pin: string; id: string; bytes: Buffer }[] = [];
    for (const mode of ['db', 's3', 'both'] as const) {
      if (mode !== 'db') {
        await app.close();
        app = await createApp(mode);
        prisma = app.get(PrismaService);
        baseUrl = await app.getUrl();
      }
      const pin = await createPerson(mode);
      const result = await upload(pin);
      const photo = await prisma.photo.findUniqueOrThrow({
        where: { id: result.photo.id },
      });
      assert.equal(photo.mode, mode);
      assert.ok(photo.size <= 153600);
      assert.equal(photo.bytes !== null, mode !== 's3');
      assert.equal(photo.s3Key !== null, mode !== 'db');
      const downloaded = await fetch(`${baseUrl}/api/persons/${pin}/photo`, {
        headers: { 'X-API-Key': key },
      });
      assert.equal(downloaded.status, 200);
      assert.match(downloaded.headers.get('content-type')!, /image\/jpeg/);
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      assert.equal(bytes.length, photo.size);
      if (photo.bytes) assert.deepEqual(bytes, Buffer.from(photo.bytes));
      saved.push({ pin, id: photo.id, bytes });
      assert.equal(result.photo.bytes, undefined);
      assert.equal(result.photo.s3Key, undefined);
    }
    for (const photo of saved)
      assert.deepEqual(await app.get(PhotoStorage).read(photo.id), photo.bytes);
    const both = await prisma.photo.findUniqueOrThrow({ where: { id: saved[2].id } });
    await app.get(S3PhotoStorage).delete(both);
    assert.deepEqual(await app.get(PhotoStorage).read(both.id), saved[2].bytes);
    await app
      .get(PhotoStorage)
      .save(jpeg, async (photo) => {
        photoIds.push(photo.id);
        const location = { ...photo, createdAt: new Date() };
        await app.get(S3PhotoStorage).read(location);
        await assert.rejects(
          app.get(PhotoStorage).save(jpeg, async (draft) => {
            // Inject a database failure after a real S3 upload.
            photoIds.push(draft.id);
            throw new Error('Injected persistence failure');
          }),
          /Injected persistence failure/,
        );
        throw new Error('Injected persistence failure');
      })
      .catch((error) => assert.match(error.message, /Injected persistence failure/));
    for (const id of photoIds.filter((id) => !saved.some((photo) => photo.id === id))) {
      await assert.rejects(
        app.get(S3PhotoStorage).read({ ...both, id, s3Key: `photos/${id}.jpg` }),
        (error) => error instanceof PhotoStorageError && error.permanent,
      );
    }

    // JSON validation, authentication, multipart limits, and metadata-only responses.
    const pin = saved[2].pin;
    assert.equal((await fetch(`${baseUrl}/api/persons/${pin}`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/persons/${pin}`, {
          headers: { 'X-API-Key': 'wrong' },
        })
      ).status,
      401,
    );
    await request('', 'POST', { pin, name: 'Example Person' }, 409);
    await request('', 'POST', { pin: `${prefix}bad`, name: 'Bad\tName' }, 400);
    await request(`/${pin}`, 'PATCH', { pin: 'changed' }, 400);
    await upload(pin, Buffer.from('not a photo'), 400);
    await upload(pin, Buffer.alloc(10 * 1024 * 1024 + 1), 413);
    assert.equal((await request<PersonResponse>(`/${pin}`)).photo.id, both.id);
    await request('/unknown', 'GET', undefined, 404);

    const first = await device('A');
    const second = await device('B');
    const disabled = await device('C', false);
    await request<Operation>(
      `/${pin}/enroll`,
      'POST',
      { deviceSns: [first.sn, disabled.sn] },
      409,
    );
    await request(
      `/${pin}/enroll`,
      'POST',
      { deviceSns: [first.sn, 'UnknownDevice'] },
      404,
    );
    assert.equal(await prisma.personOperation.count({ where: { person: { pin } } }), 0);
    await assert.rejects(
      app
        .get(PersonsRepository)
        .enqueue(pin, 'enroll', [first.sn, second.sn].sort(), () => [
          { type: 'USERINFO', payload: 'DATA QUERY USERINFO' },
          {
            type: 'BIOPHOTO_UPLOAD',
            payload: null,
            photoId: randomUUID(),
            dependencyMode: 'confirmed',
          },
        ]),
    );
    assert.equal(await prisma.personOperation.count({ where: { person: { pin } } }), 0);
    assert.equal(
      await prisma.command.count({ where: { deviceId: { in: [first.id, second.id] } } }),
      0,
    );
    const operations: Operation[] = await Promise.all(
      Array.from({ length: 6 }, () =>
        request<Operation>(
          `/${pin}/enroll`,
          'POST',
          { deviceSns: [second.sn, first.sn] },
          202,
        ),
      ),
    );
    assert.equal(new Set(operations.map((operation) => operation.id)).size, 1);
    const operation = operations[0];
    assert.equal(operation.commands.length, 4);
    await request<Operation>(
      `/${pin}/delete-profile`,
      'POST',
      { deviceSns: [first.sn] },
      409,
    );
    const firstBody = await poll(first.sn);
    assert.match(firstBody, /DATA UPDATE USERINFO\tPIN=/);
    assert.equal(await poll(first.sn), 'OK');
    const replacement = await upload(pin, png);
    assert.notEqual(replacement.photo.id, both.id);
    await request(`/${pin}`, 'PATCH', { name: 'Updated Person' });
    await request<Operation>(`/${pin}/enroll`, 'POST', { deviceSns: [first.sn] }, 409);
    await ack(first.sn, firstBody);
    const concurrentPhotos = await Promise.all(
      Array.from({ length: 6 }, () => poll(first.sn)),
    );
    assert.equal(concurrentPhotos.filter((body) => body.startsWith('C:')).length, 1);
    const photoBody = concurrentPhotos.find((body) => body.startsWith('C:'))!;
    assert.match(photoBody, /DATA UPDATE BIOPHOTO/);
    const decoded = Buffer.from(/Content=(.*)$/.exec(photoBody)![1], 'base64');
    assert.deepEqual(decoded, saved[2].bytes);
    assert.match(photoBody, new RegExp(`Size=${decoded.length}\\t`));
    const attemptId = Number(/^C:(\d+):/.exec(photoBody)![1]);
    await prisma.commandAttempt.update({
      where: { id: attemptId },
      data: {
        sentAt: new Date(Date.now() - 120000),
        expiresAt: new Date(Date.now() - 60000),
      },
    });
    const retry = await poll(first.sn);
    assert.equal(
      retry.slice(retry.indexOf(':', 2) + 1),
      photoBody.slice(photoBody.indexOf(':', 2) + 1),
    );
    await ack(first.sn, photoBody); // A delayed success completes the active retry.
    await ack(first.sn, retry, -1004);
    // A completed device can start a new operation while another device is still enrolling.
    const independentCleanup: Operation = await request<Operation>(
      `/${pin}/delete-profile`,
      'POST',
      { deviceSns: [first.sn] },
      202,
    );
    const secondUser = await poll(second.sn);
    assert.match(secondUser, /Name=Example Person/); // Name was frozen too.
    await ack(second.sn, secondUser);
    const secondPhoto = await poll(second.sn);
    await ack(second.sn, secondPhoto);
    assert.equal(
      (await request<{ status: string }>(`/${pin}/operations/${operation.id}`)).status,
      'confirmed',
    );
    const persisted = await prisma.command.findMany({
      where: { operationId: operation.id },
    });
    assert.equal(
      persisted
        .filter((command) => command.type === 'BIOPHOTO_UPLOAD')
        .every((command) => command.payload === null),
      true,
    );
    assert.equal(JSON.stringify(persisted).includes('Content='), false);

    // Cleanup continues after an unsupported biometric type fails all five sends.
    const deletion: Operation = await request(
      `/${pin}/delete-profile`,
      'POST',
      { deviceSns: [first.sn] },
      202,
    );
    assert.equal(deletion.id, independentCleanup.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = await poll(first.sn);
      assert.match(body, /biodata Pin=.*\tType=9/);
      await ack(first.sn, body, -1004);
    }
    for (const expected of [
      /biodata Pin=.*\tType=2/,
      /biodata Pin=.*\tType=1/,
      /biophoto PIN=/,
      /USERINFO PIN=/,
    ]) {
      const body = await poll(first.sn);
      assert.match(body, expected);
      await ack(first.sn, body);
    }
    assert.equal(
      (await request<{ status: string }>(`/${pin}/operations/${deletion.id}`)).status,
      'failed',
    );
    assert.equal(
      (await request<PersonResponse>(`/${pin}`)).photo.id,
      replacement.photo.id,
    );

    // Failed USERINFO prevents a photo send, without consuming photo attempts.
    const failedPin = await createPerson('failed');
    await upload(failedPin, png);
    const failure: Operation = await request(
      `/${failedPin}/enroll`,
      'POST',
      { deviceSns: [first.sn] },
      202,
    );
    for (let attempt = 0; attempt < 5; attempt++)
      await ack(first.sn, await poll(first.sn), -1004);
    assert.equal(await poll(first.sn), 'OK');
    const failedPhoto = await prisma.command.findUniqueOrThrow({
      where: {
        id: failure.commands.find((command) => command.type === 'BIOPHOTO_UPLOAD')!.id,
      },
    });
    assert.equal(failedPhoto.status, 'failed');
    assert.equal(failedPhoto.attempts, 0);

    // Storage failures and disablement during preparation never reserve a send.
    const storagePin = saved[1].pin;
    const storageOperation: Operation = await request(
      `/${storagePin}/enroll`,
      'POST',
      { deviceSns: [first.sn] },
      202,
    );
    await ack(first.sn, await poll(first.sn));
    const commands = app.get(CommandsService);
    const photos = app.get(PhotoStorage);
    const read = photos.read.bind(photos);
    try {
      photos.read = async () => {
        throw new PhotoStorageError();
      };
      await assert.rejects(commands.next(first.id), PhotoStorageError);
      assert.equal(
        (
          await prisma.command.findUniqueOrThrow({
            where: { id: storageOperation.commands[1].id },
          })
        ).attempts,
        0,
      );
      photos.read = async (id) => {
        await prisma.device.update({ where: { id: first.id }, data: { enabled: false } });
        return read(id);
      };
      await assert.rejects(commands.next(first.id));
      assert.equal(
        (
          await prisma.command.findUniqueOrThrow({
            where: { id: storageOperation.commands[1].id },
          })
        ).attempts,
        0,
      );
    } finally {
      photos.read = read;
      await prisma.device.update({ where: { id: first.id }, data: { enabled: true } });
    }
    await app
      .get(S3PhotoStorage)
      .delete(await prisma.photo.findUniqueOrThrow({ where: { id: saved[1].id } }));
    assert.equal(await commands.next(first.id), null);
    assert.equal(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: storageOperation.commands[1].id },
        })
      ).status,
      'failed',
    );
    console.log(
      'Persons integration passed: API authentication/validation, three real storage modes, fallback/compensation, frozen snapshots, concurrent atomic enrollment, dependencies, deletion, retries, and storage/disable failures.',
    );
  } finally {
    try {
      const photos = await prisma.photo.findMany({ where: { id: { in: photoIds } } });
      for (const photo of photos) await app.get(S3PhotoStorage).delete(photo);
      await prisma.commandAttempt.deleteMany({
        where: { command: { deviceId: { in: deviceIds } } },
      });
      await prisma.command.updateMany({
        where: { deviceId: { in: deviceIds } },
        data: { predecessorId: null },
      });
      await prisma.command.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.personOperation.deleteMany({
        where: { person: { pin: { in: pins } } },
      });
      await prisma.person.deleteMany({ where: { pin: { in: pins } } });
      await prisma.photo.deleteMany({ where: { id: { in: photoIds } } });
      await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    } finally {
      await app.close();
    }
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
