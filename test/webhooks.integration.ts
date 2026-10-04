import * as assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { AttendanceRepository } from '../src/modules/attendance/attendance.repository';
import { CommandsService } from '../src/modules/commands/commands.service';
import { OutboxWriter } from '../src/modules/webhooks/outbox.writer';
import { WebhookDispatcher } from '../src/modules/webhooks/webhook-dispatcher.service';
import {
  WebhooksRepository,
  DELIVERY_LEASE_MS,
} from '../src/modules/webhooks/webhooks.repository';
import { configureBodyParsers } from '../src/shared/http/body-parsers';
import type { Env } from '../src/shared/config/env.schema';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function main(): Promise<void> {
  const prefix = `TEST${randomUUID().replace(/-/g, '')}`;
  const secret = 'synthetic-webhook-secret';
  const requests: { body: string; headers: IncomingHttpHeaders; path: string }[] = [];
  let redirected = 0;
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    requests.push({
      body: Buffer.concat(buffers).toString('utf8'),
      headers: request.headers,
      path: request.url!,
    });
    if (request.url === '/network') {
      request.socket.destroy();
      return;
    }
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(204);
        response.end();
      }, 150).unref();
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/destination' });
      response.end();
      return;
    }
    if (request.url === '/destination') redirected++;
    response.writeHead(request.url === '/error' ? 503 : 204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const testModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const originalConfig = testModule.get(ConfigService<Env, true>);
  const values: Partial<Env> = {
    DATABASE_URL: originalConfig.get('DATABASE_URL', { infer: true }),
    API_KEY: originalConfig.get('API_KEY', { infer: true }),
    PHOTO_STORAGE: 'db',
    COMMAND_ACK_TIMEOUT_SECONDS: 60,
    WEBHOOK_URL: `${receiver}/ok`,
    WEBHOOK_SECRET: secret,
    WEBHOOK_MAX_ATTEMPTS: 3,
    WEBHOOK_TIMEOUT_MS: 1000,
    WEBHOOK_POLL_INTERVAL_MS: 1000,
  };
  assert.equal(
    new URL(values.DATABASE_URL!).pathname,
    '/zk_push_test',
    'Use the separate zk_push_test database',
  );
  await testModule.close();
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
  const attendance = app.get(AttendanceRepository);
  const commands = app.get(CommandsService);
  const writer = app.get(OutboxWriter);
  const repository = app.get(WebhooksRepository);
  const deviceIds: number[] = [];
  const personIds: number[] = [];
  const dispatcher = (path = '/ok', changes: Partial<Env> = {}) =>
    new WebhookDispatcher(
      repository,
      new ConfigService<Env, true>({
        ...values,
        WEBHOOK_URL: `${receiver}${path}`,
        ...changes,
      }),
    );
  const disabled = new ConfigService<Env, true>({
    ...values,
    WEBHOOK_URL: undefined,
    WEBHOOK_SECRET: undefined,
  });
  const row = (pin: string) => ({
    pin,
    localTime: new Date('2026-10-04T08:30:00Z'),
    status: 0,
    verifyType: 15,
    raw: 'synthetic private raw payload',
  });
  const makeDevice = async () => {
    const device = await prisma.device.create({
      data: { sn: `${prefix}${deviceIds.length}`, name: 'Synthetic device' },
    });
    deviceIds.push(device.id);
    return device;
  };
  const finalEvents = (id: number) =>
    prisma.webhookDelivery.findMany({ where: { sourceKey: `command:${id}:finished` } });
  const expire = async (id: number) => {
    await prisma.commandAttempt.update({
      where: { id },
      data: { sentAt: new Date(0), expiresAt: new Date(60000) },
    });
  };
  const event = async (maxAttempts = 3) => {
    const id = randomUUID();
    const body = `{ "id": "${id}", "type": "test.event", "version": 1, "data": { "text": "José" } }`;
    return prisma.webhookDelivery.create({
      data: { id, sourceKey: `${prefix}:${id}`, type: 'test.event', body, maxAttempts },
    });
  };
  const due = (id: string) =>
    prisma.webhookDelivery.update({
      where: { id },
      data: { nextAttemptAt: new Date(0) },
    });
  const get = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const api = (path: string, method = 'GET', key: string | null = values.API_KEY!) =>
      fetch(`${base}/api/webhooks/deliveries${path}`, {
        method,
        ...(key ? { headers: { 'X-API-Key': key } } : {}),
      });
    const device = await makeDevice();
    await Promise.all(
      Array.from({ length: 5 }, () => attendance.insertBatch(device.id, [row('1001')])),
    );
    assert.equal(await prisma.attendanceLog.count({ where: { deviceId: device.id } }), 1);
    const mark = await prisma.attendanceLog.findFirstOrThrow({
      where: { deviceId: device.id },
    });
    const created = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { sourceKey: `attendance:${mark.id}` },
    });
    assert.equal(created.maxAttempts, 3);
    const envelope = JSON.parse(created.body);
    assert.equal(envelope.id, created.id);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.type, 'attendance.created');
    assert.match(envelope.occurredAt, /Z$/);
    assert.deepEqual(envelope.data, {
      attendanceId: mark.id,
      sn: device.sn,
      pin: '1001',
      localTime: '2026-10-04 08:30:00',
      status: 0,
      verifyType: 15,
      receivedAt: mark.receivedAt.toISOString(),
    });
    assert.ok(!created.body.includes('synthetic private raw payload'));
    assert.equal(await attendance.insertBatch(device.id, [row('1001')]), 0);
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { sourceKey: `attendance:${mark.id}` },
      }),
      1,
    );

    // A failure after writing events rolls back the new attendance and the entire outbox batch.
    const writeAttendance = writer.attendance.bind(writer);
    writer.attendance = async (tx, rows) => {
      await writeAttendance(tx, rows);
      throw new Error('Synthetic outbox failure');
    };
    try {
      await assert.rejects(attendance.insertBatch(device.id, [row('1002'), row('1003')]));
      const http = await fetch(`${base}/iclock/cdata?SN=${device.sn}&table=ATTLOG`, {
        method: 'POST',
        body: '1002\t2026-10-04 08:30:00\t0\t15',
      });
      assert.equal(http.status, 500);
      assert.equal(await http.text(), 'ERROR');
    } finally {
      writer.attendance = writeAttendance;
    }
    assert.equal(await prisma.attendanceLog.count({ where: { deviceId: device.id } }), 1);
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { type: 'attendance.created', body: { contains: device.sn } },
      }),
      1,
    );

    // Disabled producers do not backfill historical attendance when enabled again.
    const disabledAttendance = new AttendanceRepository(
      prisma,
      new OutboxWriter(disabled),
    );
    await disabledAttendance.insertBatch(device.id, [row('1004')]);
    assert.equal(await attendance.insertBatch(device.id, [row('1004')]), 0);
    const old = await prisma.attendanceLog.findFirstOrThrow({
      where: { deviceId: device.id, pin: '1004' },
    });
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { sourceKey: `attendance:${old.id}` },
      }),
      0,
    );
    const paused = await event();
    assert.equal(await new WebhookDispatcher(repository, disabled).dispatchOnce(), 0);
    assert.equal((await get(paused.id)).attempts, 0);

    // Generic commands have no operation or PIN; only their final transition emits an event.
    const generic = (
      await commands.enqueue({
        deviceId: device.id,
        type: 'QUERY',
        payload: 'DATA QUERY USERINFO',
      })
    ).command;
    assert.equal((await finalEvents(generic.id)).length, 0);
    const sent = (await commands.next(device.id))!;
    const writeCommand = writer.command.bind(writer);
    writer.command = async (tx, id) => {
      await writeCommand(tx, id);
      throw new Error('Synthetic outbox failure');
    };
    try {
      await assert.rejects(commands.respond(device.id, [{ id: sent.id, returnCode: 0 }]));
    } finally {
      writer.command = writeCommand;
    }
    assert.equal(
      (await prisma.command.findUniqueOrThrow({ where: { id: generic.id } })).status,
      'sent',
    );
    assert.equal(
      (await prisma.commandAttempt.findUniqueOrThrow({ where: { id: sent.id } }))
        .respondedAt,
      null,
    );
    assert.equal((await finalEvents(generic.id)).length, 0);
    await commands.respond(device.id, [{ id: sent.id, returnCode: 0 }]);
    await commands.respond(device.id, [{ id: sent.id, returnCode: -1 }]);
    const finished = (await finalEvents(generic.id))[0];
    assert.equal((await finalEvents(generic.id)).length, 1);
    assert.deepEqual(JSON.parse(finished.body).data, {
      commandId: generic.id,
      type: 'QUERY',
      operationId: null,
      pin: null,
      sn: device.sn,
      attempts: 1,
      maxAttempts: 5,
      returnCode: 0,
    });
    assert.ok(!finished.body.includes('DATA QUERY'));

    for (const timeout of [false, true]) {
      const terminal = (
        await commands.enqueue({
          deviceId: device.id,
          type: 'QUERY',
          payload: 'DATA QUERY USERINFO',
        })
      ).command;
      for (let i = 1; i <= 5; i++) {
        const attempt = (await commands.next(device.id))!;
        if (timeout) await expire(attempt.id);
        else await commands.respond(device.id, [{ id: attempt.id, returnCode: -1004 }]);
        assert.equal(
          (await finalEvents(terminal.id)).length,
          !timeout && i === 5 ? 1 : 0,
        );
      }
      assert.equal(await commands.next(device.id), null);
      const events = await finalEvents(terminal.id);
      assert.equal(events.length, 1);
      const data = JSON.parse(events[0].body).data;
      assert.equal(events[0].type, 'command.failed');
      assert.equal(
        data.reason,
        timeout ? 'Acknowledgement timeout exhausted' : 'Device error exhausted',
      );
      assert.equal(data.returnCode, timeout ? null : -1004);
      assert.equal(data.attempts, 5);
    }

    // Unavailable photo and dependent commands each emit exactly one failed event.
    const person = await prisma.person.create({
      data: { pin: `P${prefix.slice(4, 12)}`, name: 'John Doe' },
    });
    personIds.push(person.id);
    const operation = await prisma.personOperation.create({
      data: { personId: person.id, action: 'enroll', version: 1, deviceSns: [device.sn] },
    });
    const unavailable = await prisma.command.create({
      data: {
        deviceId: device.id,
        personId: person.id,
        operationId: operation.id,
        type: 'BIOPHOTO_UPLOAD',
        profileSnapshot: { pin: person.pin },
      },
    });
    const child = await prisma.command.create({
      data: {
        deviceId: device.id,
        personId: person.id,
        operationId: operation.id,
        type: 'BIOPHOTO_UPLOAD',
        predecessorId: unavailable.id,
        dependencyMode: 'requireConfirmed',
      },
    });
    assert.equal(await commands.next(device.id), null);
    for (const [id, reason] of [
      [unavailable.id, 'Photo or payload is unavailable'],
      [child.id, 'Predecessor failed'],
    ] as const) {
      const events = await finalEvents(id);
      assert.equal(events.length, 1);
      const data = JSON.parse(events[0].body).data;
      assert.equal(data.reason, reason);
      assert.equal(data.pin, person.pin);
      assert.equal(data.operationId, operation.id);
      assert.ok(!events[0].body.includes('profileSnapshot'));
    }
    assert.equal(await commands.next(device.id), null);
    assert.equal((await finalEvents(child.id)).length, 1);

    // An ACK batch containing two final transitions is atomic even when its second event fails.
    const batchDevice = await makeDevice();
    const first = (
      await commands.enqueue({
        deviceId: batchDevice.id,
        type: 'QUERY',
        payload: 'DATA QUERY USERINFO',
      })
    ).command;
    const firstAttempt = (await commands.next(batchDevice.id))!;
    const second = (
      await commands.enqueue({
        deviceId: batchDevice.id,
        type: 'QUERY',
        payload: 'DATA QUERY USERINFO',
        priority: 10,
      })
    ).command;
    await expire(firstAttempt.id);
    const secondAttempt = (await commands.next(batchDevice.id))!;
    assert.equal(secondAttempt.commandId, second.id);
    let writes = 0;
    writer.command = async (tx, id) => {
      await writeCommand(tx, id);
      if (++writes === 2) throw new Error('Synthetic batch failure');
    };
    try {
      await assert.rejects(
        commands.respond(batchDevice.id, [
          { id: firstAttempt.id, returnCode: 0 },
          { id: secondAttempt.id, returnCode: 0 },
        ]),
      );
    } finally {
      writer.command = writeCommand;
    }
    assert.equal(
      (await prisma.command.findUniqueOrThrow({ where: { id: first.id } })).status,
      'pending',
    );
    assert.equal(
      (await prisma.command.findUniqueOrThrow({ where: { id: second.id } })).status,
      'sent',
    );
    for (const id of [firstAttempt.id, secondAttempt.id])
      assert.equal(
        (await prisma.commandAttempt.findUniqueOrThrow({ where: { id } })).respondedAt,
        null,
      );
    assert.equal((await finalEvents(first.id)).length, 0);
    assert.equal((await finalEvents(second.id)).length, 0);
    await commands.respond(batchDevice.id, [
      { id: firstAttempt.id, returnCode: 0 },
      { id: secondAttempt.id, returnCode: 0 },
    ]);
    await commands.respond(batchDevice.id, [{ id: secondAttempt.id, returnCode: 0 }]);
    assert.equal((await finalEvents(first.id)).length, 1);
    assert.equal((await finalEvents(second.id)).length, 1);

    // Drain producer events before testing isolated transport cases.
    while (await dispatcher().dispatchOnce()) {
      /* all due synthetic events */
    }
    assert.equal((await get(created.id)).status, 'delivered');
    assert.equal(
      await prisma.webhookDelivery.count({
        where: { body: { contains: prefix }, status: { in: ['pending', 'sending'] } },
      }),
      0,
    );

    const transport = await event(2);
    const beforeFailure = Date.now();
    await dispatcher('/error').dispatchOnce();
    const failedAttempt = await get(transport.id);
    assert.equal(failedAttempt.status, 'pending');
    assert.equal(failedAttempt.attempts, 1);
    assert.equal(failedAttempt.lastHttpCode, 503);
    assert.equal(failedAttempt.lastError, 'http');
    assert.ok(failedAttempt.nextAttemptAt.getTime() >= beforeFailure + 5000);
    assert.ok(failedAttempt.nextAttemptAt.getTime() <= Date.now() + 6000);
    const calls = requests.length;
    assert.equal(await dispatcher().dispatchOnce(), 0);
    assert.equal(requests.length, calls);
    await due(transport.id);
    // Wait for a different Unix second to prove the retry timestamp is regenerated.
    const originalTimestamp = requests.at(-1)!.headers['x-zk-timestamp'];
    while (String(Math.floor(Date.now() / 1000)) === originalTimestamp)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await dispatcher('/error').dispatchOnce();
    assert.equal((await get(transport.id)).status, 'failed');
    assert.equal((await get(transport.id)).attempts, 2);
    const attempts = requests.filter(
      (request) => request.headers['x-zk-event-id'] === transport.id,
    );
    assert.equal(attempts.length, 2);
    assert.notEqual(
      attempts[0].headers['x-zk-timestamp'],
      attempts[1].headers['x-zk-timestamp'],
    );
    for (const request of attempts) {
      assert.equal(request.body, transport.body);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(
        request.headers['x-zk-signature'],
        `sha256=${createHmac('sha256', secret).update(`${request.headers['x-zk-timestamp']}.${transport.body}`).digest('hex')}`,
      );
    }

    for (const [path, category, code] of [
      ['/redirect', 'http', 302],
      ['/network', 'network', null],
      ['/slow', 'timeout', null],
    ] as const) {
      const delivery = await event(1);
      await dispatcher(path, {
        WEBHOOK_TIMEOUT_MS: path === '/slow' ? 30 : 1000,
      }).dispatchOnce();
      const result = await get(delivery.id);
      assert.equal(result.status, 'failed');
      assert.equal(result.lastError, category);
      assert.equal(result.lastHttpCode, code);
    }
    assert.equal(redirected, 0);

    // Admin API: authentication, stable cursor pagination, detail, failed-only retry.
    assert.equal((await api('', 'GET', null)).status, 401);
    assert.equal((await api('', 'GET', 'wrong-key')).status, 401);
    assert.equal((await api('?limit=101')).status, 400);
    assert.equal((await api('?cursor=bad')).status, 400);
    assert.equal((await api('?status=unknown')).status, 400);
    assert.equal((await api(`/${randomUUID()}`)).status, 404);
    assert.equal((await api(`/${randomUUID()}/retry`, 'POST')).status, 404);
    const pagedIds = new Set<string>();
    let cursor = '';
    do {
      const response = await api(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(response.status, 200);
      const page = (await response.json()) as {
        items: { id: string; body?: string }[];
        nextCursor: string | null;
      };
      for (const item of page.items) {
        assert.ok(!pagedIds.has(item.id));
        assert.equal(item.body, undefined);
        pagedIds.add(item.id);
      }
      cursor = page.nextCursor ?? '';
    } while (cursor);
    assert.equal(pagedIds.size, await prisma.webhookDelivery.count());
    const detail = (await (await api(`/${transport.id}`)).json()) as {
      event: unknown;
      status: string;
    };
    assert.deepEqual(detail.event, JSON.parse(transport.body));
    assert.equal(detail.status, 'failed');
    const filtered = (await (await api('?status=failed')).json()) as {
      items: { status: string }[];
    };
    assert.ok(filtered.items.every((item) => item.status === 'failed'));
    assert.equal((await api(`/${created.id}/retry`, 'POST')).status, 409);
    const retried = await api(`/${transport.id}/retry`, 'POST');
    assert.equal(retried.status, 202);
    const reset = await get(transport.id);
    assert.equal(reset.id, transport.id);
    assert.equal(reset.body, transport.body);
    assert.equal(reset.attempts, 0);
    assert.equal(reset.maxAttempts, 2);
    assert.equal((await api(`/${transport.id}/retry`, 'POST')).status, 409);
    await dispatcher('/ok').dispatchOnce();
    assert.equal((await get(transport.id)).status, 'delivered');

    // Two workers reserve exclusively, at most five rows each, without long HTTP transactions.
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => event()));
    const [a, b] = await Promise.all([
      repository.reserve(),
      new WebhooksRepository(prisma).reserve(),
    ]);
    assert.equal(a.length, 5);
    assert.equal(b.length, 5);
    assert.equal(new Set([...a, ...b].map((delivery) => delivery.id)).size, 10);
    assert.deepEqual(
      new Set([...a, ...b].map((delivery) => delivery.id)),
      new Set(concurrent.map((delivery) => delivery.id)),
    );
    for (const delivery of [...a, ...b])
      await repository.finish(delivery, { httpCode: 204, error: null }, new Date());

    // Recover a crashed reservation; the old worker's token cannot complete its replacement.
    const crashed = await event(2);
    const oldReservation = (await repository.reserve())[0];
    assert.equal(oldReservation.id, crashed.id);
    const recoveryTime = new Date(oldReservation.lockedUntil!.getTime() + 1);
    const recovered = (await new WebhooksRepository(prisma).reserve(recoveryTime))[0];
    assert.equal(recovered.id, crashed.id);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.lockToken, oldReservation.lockToken);
    assert.equal(
      await repository.finish(oldReservation, { httpCode: 204, error: null }, new Date()),
      false,
    );
    assert.equal((await get(crashed.id)).status, 'sending');
    assert.equal(
      await repository.finish(recovered, { httpCode: 204, error: null }, new Date()),
      true,
    );
    const exhausted = await event(1);
    const finalReservation = (await repository.reserve())[0];
    assert.equal(finalReservation.id, exhausted.id);
    assert.equal(
      finalReservation.lockedUntil!.getTime() - finalReservation.updatedAt.getTime(),
      DELIVERY_LEASE_MS,
    );
    await repository.reserve(new Date(finalReservation.lockedUntil!.getTime() + 1));
    assert.equal((await get(exhausted.id)).status, 'failed');
    assert.equal((await get(exhausted.id)).lastError, 'lease_expired');
    assert.equal(
      await repository.finish(
        finalReservation,
        { httpCode: 204, error: null },
        new Date(),
      ),
      false,
    );

    // A new worker uses its startup destination/secret for already pending events.
    const changed = await event();
    await dispatcher('/destination', {
      WEBHOOK_SECRET: 'replacement-secret',
    }).dispatchOnce();
    assert.equal((await get(changed.id)).status, 'delivered');
    const lastRequest = requests.at(-1)!;
    assert.equal(lastRequest.path, '/destination');
    assert.equal(
      lastRequest.headers['x-zk-signature'],
      `sha256=${createHmac('sha256', 'replacement-secret').update(`${lastRequest.headers['x-zk-timestamp']}.${changed.body}`).digest('hex')}`,
    );
    console.log(
      'Webhooks integration passed: atomic producers/rollback, final command paths, disabled mode, signing, retries, redirects, network/timeouts, admin API, concurrent reservations, lease recovery and fencing.',
    );
  } finally {
    try {
      await prisma.webhookDelivery.deleteMany({
        where: {
          OR: [{ sourceKey: { startsWith: prefix } }, { body: { contains: prefix } }],
        },
      });
      await prisma.commandAttempt.deleteMany({
        where: { command: { deviceId: { in: deviceIds } } },
      });
      await prisma.command.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.personOperation.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma.attendanceLog.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
