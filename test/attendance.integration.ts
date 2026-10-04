import { configureBodyParsers } from '../src/shared/http/body-parsers';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { AttendanceService } from '../src/modules/attendance/attendance.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function main(): Promise<void> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const config = module.get(ConfigService);
  const database = new URL(config.getOrThrow<string>('DATABASE_URL'));
  assert.equal(
    database.pathname,
    '/zk_push_test',
    'Integration tests require the separate zk_push_test database',
  );

  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  configureBodyParsers(app);
  const prisma = app.get(PrismaService);
  const sn = `TEST${randomUUID().replace(/-/g, '')}`;
  const otherSn = `${sn}B`;
  const line = '1001\t2026-09-25 08:03:12\t0\t15\t0';

  try {
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();
    const upload = async (body: string, deviceSn = sn, table = 'ATTLOG') => {
      const response = await fetch(
        `${baseUrl}/iclock/cdata?SN=${deviceSn}&table=${table}`,
        {
          method: 'POST',
          body,
        },
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
      return response.text();
    };

    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const response = await fetch(`${baseUrl}/iclock/cdata?SN=${sn}`);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /GET OPTION FROM:/);
      }),
    );
    assert.equal(await prisma.device.count({ where: { sn } }), 1);

    assert.equal(await upload(`${line}\r\n${line}\r\nbroken row`), 'OK: 3');
    assert.equal(await prisma.attendanceLog.count({ where: { device: { sn } } }), 1);
    assert.equal(await upload(line), 'OK: 1');
    assert.equal(await prisma.attendanceLog.count({ where: { device: { sn } } }), 1);

    // Concurrent retransmissions must leave exactly one row for this new PIN.
    const nextLine = line.replace('1001', '1002');
    await Promise.all(Array.from({ length: 5 }, () => upload(nextLine)));
    assert.equal(await prisma.attendanceLog.count({ where: { device: { sn } } }), 2);

    await upload(line, otherSn);
    assert.equal(
      await prisma.attendanceLog.count({ where: { device: { sn: otherSn } } }),
      1,
    );
    assert.equal(await upload(line, sn, 'OPERLOG'), 'OK');
    assert.equal(await upload(''), 'OK: 0');
    assert.equal(await prisma.attendanceLog.count({ where: { device: { sn } } }), 2);

    const device = await prisma.device.findUniqueOrThrow({ where: { sn } });
    assert.equal(device.enabled, true);
    assert.equal(device.name, `Device ${sn}`);
    assert.ok(device.ip);
    assert.ok(device.lastSeenAt);
    assert.equal(await prisma.device.count({ where: { sn } }), 1);

    await upload(
      '~DeviceName=Example Device,FWVersion=1.0\r\nUserCount=0\r\nFaceCount=12',
      sn,
      'OPTIONS',
    );
    await upload('UserCount=invalid\nFaceCount=-1\nFWVersion=', sn, 'OPTIONS');
    const metadata = await prisma.device.findUniqueOrThrow({ where: { sn } });
    assert.equal(metadata.model, 'Example Device');
    assert.equal(metadata.firmware, '1.0');
    assert.equal(metadata.userCount, 0);
    assert.equal(metadata.faceCount, 12);

    await prisma.device.update({ where: { sn }, data: { enabled: false } });
    for (const [method, endpoint, query] of [
      ['GET', 'cdata', ''],
      ['POST', 'cdata', '&table=ATTLOG'],
      ['POST', 'cdata', '&table=OPTIONS'],
      ['GET', 'getrequest', ''],
      ['POST', 'devicecmd', ''],
    ]) {
      const response = await fetch(`${baseUrl}/iclock/${endpoint}?SN=${sn}${query}`, {
        method,
        ...(method === 'POST' ? { body: 'UserCount=999' } : {}),
      });
      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'DEVICE DISABLED');
    }
    const disabled = await prisma.device.findUniqueOrThrow({ where: { sn } });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.userCount, 0);
    assert.ok(
      disabled.lastSeenAt &&
        metadata.lastSeenAt &&
        disabled.lastSeenAt >= metadata.lastSeenAt,
    );
    assert.equal(await prisma.attendanceLog.count({ where: { device: { sn } } }), 2);
    await assert.rejects(prisma.device.delete({ where: { sn } }));
    await prisma.device.update({ where: { sn }, data: { enabled: true } });
    assert.equal(await upload(line), 'OK: 1');

    const stored = await prisma.attendanceLog.findFirstOrThrow({
      where: { device: { sn }, pin: '1001' },
    });
    assert.equal(stored.raw, line);
    assert.equal(stored.localTime.toISOString(), '2026-09-25T08:03:12.000Z');
    const clock = await prisma.$queryRaw<{ localClock: string }[]>`
      SELECT to_char("localTime", 'YYYY-MM-DD HH24:MI:SS') AS "localClock"
      FROM "AttendanceLog" WHERE "deviceId" = ${stored.deviceId} AND pin = '1001'
    `;
    assert.equal(clock[0].localClock, '2026-09-25 08:03:12');

    const result = await app.get(AttendanceService).saveBatch(stored.deviceId, [
      {
        pin: '1001',
        localTime: stored.localTime,
        status: 0,
        verifyType: 15,
        raw: line,
      },
      {
        pin: '1003',
        localTime: stored.localTime,
        status: 0,
        verifyType: 15,
        raw: line.replace('1001', '1003'),
      },
    ]);
    assert.deepEqual(result, { created: 1, duplicates: 1 });
    console.log(
      'Attendance integration passed: persistence, mixed batches, concurrent deduplication, device isolation, counters, terminal time, OPTIONS, disable/reactivate, and delete restriction.',
    );
  } finally {
    try {
      await prisma.attendanceLog.deleteMany({
        where: { device: { sn: { in: [sn, otherSn] } } },
      });
      await prisma.device.deleteMany({ where: { sn: { in: [sn, otherSn] } } });
    } finally {
      await app.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
