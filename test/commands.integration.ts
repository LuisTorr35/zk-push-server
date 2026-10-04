import { configureBodyParsers } from '../src/shared/http/body-parsers';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { CommandsService } from '../src/modules/commands/commands.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function createApp(): Promise<NestExpressApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const database = new URL(module.get(ConfigService).getOrThrow<string>('DATABASE_URL'));
  assert.equal(
    database.pathname,
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
  let app = await createApp();
  let prisma = app.get(PrismaService);
  let commands = app.get(CommandsService);
  let baseUrl = await app.getUrl();
  const prefix = `TEST${randomUUID().replace(/-/g, '')}`;
  const deviceIds: number[] = [];
  const payload = 'DATA QUERY USERINFO';

  const device = async (suffix: string) => {
    const row = await prisma.device.create({
      data: { sn: `${prefix}${suffix}`, name: 'Test terminal' },
    });
    deviceIds.push(row.id);
    return row;
  };
  const poll = async (sn: string) => {
    const response = await fetch(`${baseUrl}/iclock/getrequest?SN=${sn}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    return response.text();
  };
  const acknowledge = async (sn: string, body: string) => {
    const response = await fetch(`${baseUrl}/iclock/devicecmd?SN=${sn}`, {
      method: 'POST',
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
  };
  const deliveryId = (body: string) => {
    const match = /^C:(\d+):(.+)$/.exec(body);
    assert.ok(match, `Expected delivery, received ${body}`);
    assert.equal(match[2], payload);
    return Number(match[1]);
  };
  const expire = (id: number) =>
    prisma.commandAttempt.update({
      where: { id },
      data: {
        sentAt: new Date(Date.now() - 120000),
        expiresAt: new Date(Date.now() - 60000),
      },
    });
  const status = async (id: number) =>
    (await prisma.command.findUniqueOrThrow({ where: { id } })).status;

  try {
    const primary = await device('A');
    const other = await device('B');
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        commands.enqueue({
          deviceId: primary.id,
          type: 'QUERY',
          payload,
          priority: 10,
          dedupeKey: 'user:1001',
        }),
      ),
    );
    assert.equal(new Set(duplicates.map((result) => result.command.id)).size, 1);
    assert.equal(duplicates.filter((result) => !result.duplicate).length, 1);
    assert.equal(
      (await prisma.device.findUniqueOrThrow({ where: { id: primary.id } })).lastSeenAt,
      null,
    );
    const high = duplicates[0].command;
    const low = (
      await commands.enqueue({
        deviceId: primary.id,
        type: 'QUERY',
        payload,
        priority: 0,
      })
    ).command;
    const otherCommand = (
      await commands.enqueue({
        deviceId: other.id,
        type: 'QUERY',
        payload,
        dedupeKey: 'user:1001',
      })
    ).command;
    await assert.rejects(
      prisma.command.create({
        data: {
          deviceId: primary.id,
          type: 'QUERY',
          payload,
          dedupeKey: 'user:1001',
        },
      }),
    );

    const polls = await Promise.all(Array.from({ length: 8 }, () => poll(primary.sn)));
    assert.equal(polls.filter((body) => body.startsWith('C:')).length, 1);
    assert.equal(polls.filter((body) => body === 'OK').length, 7);
    const first = deliveryId(polls.find((body) => body.startsWith('C:'))!);
    const attempt = await prisma.commandAttempt.findUniqueOrThrow({
      where: { id: first },
    });
    assert.equal(attempt.commandId, high.id);
    assert.equal(attempt.number, 1);
    assert.equal(attempt.expiresAt.getTime() - attempt.sentAt.getTime(), 60000);
    assert.equal(await status(low.id), 'pending');
    assert.equal(await status(otherCommand.id), 'pending');
    await assert.rejects(
      prisma.command.create({
        data: { deviceId: primary.id, type: 'QUERY', payload, status: 'sent' },
      }),
    );
    await assert.rejects(prisma.device.delete({ where: { id: primary.id } }));

    await acknowledge(other.sn, `ID=${first}&Return=0`);
    assert.equal(await status(high.id), 'sent');
    assert.equal(
      (await prisma.commandAttempt.findUniqueOrThrow({ where: { id: first } }))
        .respondedAt,
      null,
    );
    await acknowledge(
      primary.sn,
      `broken\r\nID=${first}&Return=0&CMD=DATA\r\nID=2147483647&Return=0`,
    );
    const confirmed = await prisma.command.findUniqueOrThrow({ where: { id: high.id } });
    assert.equal(confirmed.status, 'confirmed');
    await acknowledge(primary.sn, `ID=${first}&Return=-1004\nID=${first}&Return=0`);
    assert.deepEqual(
      await prisma.command.findUniqueOrThrow({ where: { id: high.id } }),
      confirmed,
    );
    assert.equal(
      (
        await commands.enqueue({
          deviceId: primary.id,
          type: 'QUERY',
          payload,
          dedupeKey: 'user:1001',
        })
      ).duplicate,
      false,
    );

    const orderDevice = await device('C');
    const older = (
      await commands.enqueue({ deviceId: orderDevice.id, type: 'QUERY', payload })
    ).command;
    const newer = (
      await commands.enqueue({ deviceId: orderDevice.id, type: 'QUERY', payload })
    ).command;
    // Force a timestamp tie to verify the ID tie-breaker without timing assumptions.
    await prisma.command.updateMany({
      where: { deviceId: orderDevice.id },
      data: { createdAt: older.createdAt },
    });
    const ordered = await commands.next(orderDevice.id);
    assert.ok(ordered);
    assert.equal(ordered.commandId, older.id);
    await commands.respond(orderDevice.id, [{ id: ordered.id, returnCode: 0 }]);
    assert.equal((await commands.next(orderDevice.id))?.commandId, newer.id);

    const errorDevice = await device('D');
    const errorCommand = (
      await commands.enqueue({ deviceId: errorDevice.id, type: 'QUERY', payload })
    ).command;
    let previousId = 0;
    for (let number = 1; number <= 5; number++) {
      const current = deliveryId(await poll(errorDevice.sn));
      assert.notEqual(current, previousId);
      await acknowledge(errorDevice.sn, `ID=${current}&Return=-1004`);
      assert.equal(await status(errorCommand.id), number === 5 ? 'failed' : 'pending');
      previousId = current;
    }
    assert.equal(await poll(errorDevice.sn), 'OK');
    assert.equal(
      (await prisma.command.findUniqueOrThrow({ where: { id: errorCommand.id } }))
        .attempts,
      5,
    );
    await acknowledge(errorDevice.sn, `ID=${previousId}&Return=0`);
    assert.equal(await status(errorCommand.id), 'failed');

    const timeoutDevice = await device('E');
    const timedCommand = (
      await commands.enqueue({ deviceId: timeoutDevice.id, type: 'QUERY', payload })
    ).command;
    for (let number = 1; number <= 5; number++) {
      const current = await commands.next(timeoutDevice.id);
      assert.ok(current);
      assert.equal(
        (await prisma.commandAttempt.findUniqueOrThrow({ where: { id: current.id } }))
          .number,
        number,
      );
      await expire(current.id);
    }
    assert.equal(await commands.next(timeoutDevice.id), null);
    assert.equal(await status(timedCommand.id), 'failed');

    const lateDevice = await device('F');
    const lateCommand = (
      await commands.enqueue({ deviceId: lateDevice.id, type: 'QUERY', payload })
    ).command;
    const lateFirst = (await commands.next(lateDevice.id))!;
    await expire(lateFirst.id);
    const lateSecond = (await commands.next(lateDevice.id))!;
    assert.notEqual(lateFirst.id, lateSecond.id);
    await commands.respond(lateDevice.id, [{ id: lateFirst.id, returnCode: -1004 }]);
    assert.equal(await status(lateCommand.id), 'sent');
    assert.equal(
      (await prisma.command.findUniqueOrThrow({ where: { id: lateCommand.id } }))
        .attempts,
      2,
    );
    // A duplicate result cannot overwrite the first recorded response.
    await commands.respond(lateDevice.id, [{ id: lateFirst.id, returnCode: 0 }]);
    assert.equal(await status(lateCommand.id), 'sent');
    await commands.respond(lateDevice.id, [{ id: lateSecond.id, returnCode: 0 }]);
    assert.equal(await status(lateCommand.id), 'confirmed');

    const successDevice = await device('G');
    const delayed = (
      await commands.enqueue({ deviceId: successDevice.id, type: 'QUERY', payload })
    ).command;
    const successFirst = (await commands.next(successDevice.id))!;
    await expire(successFirst.id);
    const successSecond = (await commands.next(successDevice.id))!;
    await commands.respond(successDevice.id, [{ id: successFirst.id, returnCode: 0 }]);
    assert.equal(await status(delayed.id), 'confirmed');
    await commands.respond(successDevice.id, [{ id: successSecond.id, returnCode: -1 }]);
    assert.equal(await status(delayed.id), 'confirmed');
    assert.equal(await commands.next(successDevice.id), null);

    const rollbackDevice = await device('H');
    const rollbackCommand = (
      await commands.enqueue({ deviceId: rollbackDevice.id, type: 'QUERY', payload })
    ).command;
    const rollbackFirst = (await commands.next(rollbackDevice.id))!;
    await expire(rollbackFirst.id);
    const rollbackSecond = (await commands.next(rollbackDevice.id))!;
    // Force a database write failure after a valid response in the same batch.
    await assert.rejects(
      commands.respond(rollbackDevice.id, [
        { id: rollbackFirst.id, returnCode: 0 },
        { id: rollbackSecond.id, returnCode: 2147483648 },
      ]),
    );
    assert.equal(await status(rollbackCommand.id), 'sent');
    assert.equal(
      (await prisma.commandAttempt.findUniqueOrThrow({ where: { id: rollbackFirst.id } }))
        .respondedAt,
      null,
    );
    await commands.respond(rollbackDevice.id, [{ id: rollbackSecond.id, returnCode: 0 }]);

    const restartDevice = await device('I');
    const restartCommand = (
      await commands.enqueue({ deviceId: restartDevice.id, type: 'QUERY', payload })
    ).command;
    const beforeRestart = (await commands.next(restartDevice.id))!;
    await app.close();
    app = await createApp();
    prisma = app.get(PrismaService);
    commands = app.get(CommandsService);
    baseUrl = await app.getUrl();
    assert.equal(await poll(restartDevice.sn), 'OK');
    await expire(beforeRestart.id);
    const afterRestart = deliveryId(await poll(restartDevice.sn));
    assert.notEqual(beforeRestart.id, afterRestart);
    assert.equal(
      (await prisma.commandAttempt.findUniqueOrThrow({ where: { id: afterRestart } }))
        .commandId,
      restartCommand.id,
    );

    const disabledDevice = await device('J');
    const disabledCommand = (
      await commands.enqueue({ deviceId: disabledDevice.id, type: 'QUERY', payload })
    ).command;
    await prisma.device.update({
      where: { id: disabledDevice.id },
      data: { enabled: false },
    });
    await assert.rejects(
      commands.enqueue({ deviceId: disabledDevice.id, type: 'QUERY', payload }),
    );
    await assert.rejects(commands.next(disabledDevice.id));
    for (const endpoint of ['getrequest', 'devicecmd']) {
      const response = await fetch(
        `${baseUrl}/iclock/${endpoint}?SN=${disabledDevice.sn}`,
        {
          method: endpoint === 'devicecmd' ? 'POST' : 'GET',
        },
      );
      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'DEVICE DISABLED');
    }
    assert.equal(await status(disabledCommand.id), 'pending');
    await prisma.device.update({
      where: { id: disabledDevice.id },
      data: { enabled: true },
    });
    assert.ok((await poll(disabledDevice.sn)).startsWith('C:'));
    await assert.rejects(
      commands.enqueue({ deviceId: 2147483647, type: 'QUERY', payload }),
    );
    console.log(
      'Commands integration passed: concurrent dedupe/polling, priority, isolation, retries, deadlines, duplicate/late responses, rollback, restart, and disabled devices.',
    );
  } finally {
    try {
      await prisma.commandAttempt.deleteMany({
        where: { command: { deviceId: { in: deviceIds } } },
      });
      await prisma.command.deleteMany({ where: { deviceId: { in: deviceIds } } });
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
