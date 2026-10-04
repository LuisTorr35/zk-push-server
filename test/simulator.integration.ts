import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFile } from 'node:fs/promises';
import { AppModule } from '../src/app.module';
import { CommandsService } from '../src/modules/commands/commands.service';
import { WebhookDispatcher } from '../src/modules/webhooks/webhook-dispatcher.service';
import { WebhooksRepository } from '../src/modules/webhooks/webhooks.repository';
import type { Env } from '../src/shared/config/env.schema';
import { configureBodyParsers } from '../src/shared/http/body-parsers';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function main(): Promise<void> {
  const seed = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const original = seed.get(ConfigService<Env, true>);
  const database = original.get('DATABASE_URL', { infer: true });
  assert.equal(
    new URL(database).pathname,
    '/zk_push_test',
    'Integration requires zk_push_test',
  );
  const key = original.get('API_KEY', { infer: true });
  await seed.close();
  const prefix = `TEST${randomUUID().replace(/-/g, '')}`;
  const sn = `${prefix}A`;
  const pin = `T${prefix.slice(4, 19)}`;
  const secret = 'synthetic-simulator-secret';
  const received: {
    id: string;
    type: string;
    data: { commandId?: number; attendanceId?: number };
  }[] = [];
  let receiverError: unknown;
  const receiver = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      assert.equal(
        request.headers['x-zk-signature'],
        `sha256=${createHmac('sha256', secret).update(`${request.headers['x-zk-timestamp']}.${body}`).digest('hex')}`,
      );
      const event = JSON.parse(body);
      assert.equal(request.headers['x-zk-event-id'], event.id);
      received.push(event);
      response.writeHead(204);
      response.end();
    } catch (error) {
      receiverError = error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((ready) => receiver.listen(0, '127.0.0.1', ready));
  const values: Partial<Env> = {
    DATABASE_URL: database,
    API_KEY: key,
    PHOTO_STORAGE: 'db',
    COMMAND_ACK_TIMEOUT_SECONDS: 1,
    WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`,
    WEBHOOK_SECRET: secret,
    WEBHOOK_TIMEOUT_MS: 1000,
    WEBHOOK_MAX_ATTEMPTS: 3,
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService<Env, true>(values))
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  configureBodyParsers(app);
  const prisma = app.get(PrismaService);
  const commands = app.get(CommandsService);
  const dispatcher = new WebhookDispatcher(
    app.get(WebhooksRepository),
    new ConfigService<Env, true>(values),
  );
  const photos: string[] = [];
  let base = '';

  async function cli(args: string[], expectedCode = 0): Promise<string> {
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/ts-node/dist/bin.js'),
        'tools/simulator/main.ts',
        '--url',
        base,
        '--sn',
        sn,
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const [code] = await once(child, 'close');
      assert.equal(code, expectedCode, output);
      return output;
    } finally {
      clearTimeout(timer);
    }
  }
  const api = (path: string, method = 'GET', body?: object) =>
    fetch(`${base}/api/persons${path}`, {
      method,
      headers: {
        'X-API-Key': key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  async function operation(action: string) {
    const response = await api(`/${pin}/${action}`, 'POST', { deviceSns: [sn] });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()) as {
      id: string;
      commands: { id: number; type: string }[];
    };
  }

  try {
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const smoke = await cli([
      '--scenario',
      'smoke',
      '--pin',
      pin,
      '--local-time',
      '2026-10-04 08:30:00',
      '--repeat',
      '2',
      '--polls',
      '1',
    ]);
    assert.match(smoke, /OPTIONS acknowledged/);
    assert.match(smoke, /ATTLOG batch=2 lines=1 acknowledged/);
    const device = await prisma.device.findUniqueOrThrow({ where: { sn } });
    assert.equal(device.model, 'Simulator');
    assert.equal(device.firmware, 'simulator');
    assert.equal(device.userCount, 0);
    const logs = await prisma.attendanceLog.findMany({ where: { deviceId: device.id } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].pin, pin);
    assert.equal(logs[0].localTime.toISOString(), '2026-10-04T08:30:00.000Z');
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { sourceKey: `attendance:${logs[0].id}` },
      }),
      1,
    );
    await cli([
      '--scenario',
      'attendance',
      '--file',
      'test/fixtures/iclock/attlog-basic.txt',
      '--repeat',
      '2',
    ]);
    assert.equal(await prisma.attendanceLog.count({ where: { deviceId: device.id } }), 4);

    const created = await api('', 'POST', { pin, name: 'John: Doe' });
    assert.equal(created.status, 201);
    const jpeg = await readFile('test/fixtures/iclock/simulator-photo.jpg');
    const form = new FormData();
    form.set(
      'photo',
      new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
      'synthetic.jpg',
    );
    const upload = await fetch(`${base}/api/persons/${pin}/photo`, {
      method: 'PUT',
      headers: { 'X-API-Key': key },
      body: form,
    });
    assert.equal(upload.status, 200);
    const uploaded = (await upload.json()) as { photo: { id: string } };
    photos.push(uploaded.photo.id);
    const enrolled = await operation('enroll');
    assert.equal(enrolled.commands.length, 2);
    const enrollment = await cli([
      '--scenario',
      'poll',
      '--polls',
      '2',
      '--interval-ms',
      '20',
    ]);
    assert.equal((enrollment.match(/COMMAND attempt=/g) ?? []).length, 2);
    assert.ok(!/Content=|John: Doe|DATA UPDATE/.test(enrollment));
    const enrollmentRows = await prisma.command.findMany({
      where: { operationId: enrolled.id },
    });
    assert.ok(
      enrollmentRows.every(
        (command) => command.status === 'confirmed' && command.attempts === 1,
      ),
    );
    assert.equal(
      enrollmentRows.find((command) => command.type === 'BIOPHOTO_UPLOAD')!.payload,
      null,
    );
    const deleted = await operation('delete-profile');
    assert.equal(deleted.commands.length, 5);
    await cli(['--scenario', 'poll', '--polls', '5', '--interval-ms', '20']);
    assert.equal(
      await prisma.command.count({
        where: { operationId: deleted.id, status: 'confirmed' },
      }),
      5,
    );
    assert.ok(await prisma.person.findUnique({ where: { pin } }));

    const failed = (
      await commands.enqueue({
        deviceId: device.id,
        type: 'QUERY',
        payload: 'DATA QUERY USERINFO',
      })
    ).command;
    const errors = await cli([
      '--scenario',
      'poll',
      '--ack',
      'error',
      '--return-code',
      '-1004',
      '--polls',
      '6',
      '--interval-ms',
      '20',
    ]);
    assert.equal((errors.match(/return=-1004/g) ?? []).length, 5);
    const failure = await prisma.command.findUniqueOrThrow({ where: { id: failed.id } });
    assert.equal(failure.status, 'failed');
    assert.equal(failure.attempts, 5);
    assert.equal(failure.returnCode, -1004);

    const timed = (
      await commands.enqueue({
        deviceId: device.id,
        type: 'QUERY',
        payload: 'DATA QUERY USERINFO',
      })
    ).command;
    const timeouts = await cli([
      '--scenario',
      'poll',
      '--ack',
      'none',
      '--polls',
      '6',
      '--interval-ms',
      '1100',
    ]);
    assert.equal((timeouts.match(/ACK attempt=\d+ skipped/g) ?? []).length, 5);
    const exhausted = await prisma.command.findUniqueOrThrow({ where: { id: timed.id } });
    assert.equal(exhausted.status, 'failed');
    assert.equal(exhausted.attempts, 5);
    assert.equal(exhausted.returnCode, null);
    assert.equal(exhausted.failureReason, 'Acknowledgement timeout exhausted');
    const attempts = await prisma.commandAttempt.findMany({
      where: { commandId: timed.id },
    });
    assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, 5);
    assert.ok(attempts.every((attempt) => attempt.respondedAt === null));

    await prisma.device.update({ where: { id: device.id }, data: { enabled: false } });
    const forbidden = await cli(['--scenario', 'attendance'], 1);
    assert.match(forbidden, /HTTP 403/);
    assert.equal(await prisma.attendanceLog.count({ where: { deviceId: device.id } }), 4);
    await prisma.device.update({ where: { id: device.id }, data: { enabled: true } });

    // Exercise SIGINT on a real CLI process while it waits between polls.
    const watcher = spawn(
      process.execPath,
      [
        resolve('node_modules/ts-node/dist/bin.js'),
        'tools/simulator/main.ts',
        '--url',
        base,
        '--sn',
        sn,
        '--scenario',
        'poll',
        '--watch',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let watcherOutput = '';
    let signalSent = false;
    watcher.stdout.on('data', (chunk) => {
      watcherOutput += String(chunk);
      if (!signalSent && watcherOutput.includes('POLL number=1 empty')) {
        signalSent = true;
        watcher.kill('SIGINT');
      }
    });
    watcher.stderr.on('data', (chunk) => {
      watcherOutput += String(chunk);
    });
    const watcherTimer = setTimeout(() => watcher.kill('SIGKILL'), 30000);
    try {
      const [code] = await once(watcher, 'close');
      assert.equal(code, 0, watcherOutput);
      assert.match(watcherOutput, /SIMULATOR stopped/);
    } finally {
      clearTimeout(watcherTimer);
    }

    const events = await prisma.webhookDelivery.findMany({
      where: { body: { contains: sn } },
    });
    assert.equal(events.filter((event) => event.type === 'attendance.created').length, 4);
    assert.equal(events.filter((event) => event.type === 'command.confirmed').length, 7);
    assert.equal(events.filter((event) => event.type === 'command.failed').length, 2);
    while (await dispatcher.dispatchOnce()) {
      /* deliver all due synthetic events */
    }
    assert.equal(receiverError, undefined);
    assert.equal(received.length, events.length);
    assert.equal(new Set(received.map((event) => event.id)).size, events.length);
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { body: { contains: sn }, status: 'delivered' },
      }),
      events.length,
    );
    console.log(
      'Simulator integration passed: real CLI registration/OPTIONS, byte-identical attendance replay, enrollment/photo/deletion, error and timeout exhaustion, disablement, SIGINT, and signed webhook delivery.',
    );
  } finally {
    try {
      await prisma.webhookDelivery.deleteMany({ where: { body: { contains: prefix } } });
      await prisma.commandAttempt.deleteMany({ where: { command: { device: { sn } } } });
      await prisma.command.deleteMany({ where: { device: { sn } } });
      await prisma.personOperation.deleteMany({ where: { person: { pin } } });
      await prisma.person.deleteMany({ where: { pin } });
      await prisma.photo.deleteMany({ where: { id: { in: photos } } });
      await prisma.attendanceLog.deleteMany({ where: { device: { sn } } });
      await prisma.device.deleteMany({ where: { sn } });
    } finally {
      await app.close();
      await new Promise<void>((ready, reject) =>
        receiver.close((error) => (error ? reject(error) : ready())),
      );
    }
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
