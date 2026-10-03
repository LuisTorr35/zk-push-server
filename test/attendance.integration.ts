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

  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.useBodyParser('text', { type: () => true, limit: '25mb' });
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

    assert.equal(await upload(`${line}\r\n${line}\r\nbroken row`), 'OK: 3');
    assert.equal(await prisma.attendanceLog.count({ where: { deviceSn: sn } }), 1);
    assert.equal(await upload(line), 'OK: 1');
    assert.equal(await prisma.attendanceLog.count({ where: { deviceSn: sn } }), 1);

    // Concurrent retransmissions must leave exactly one row for this new PIN.
    const nextLine = line.replace('1001', '1002');
    await Promise.all(Array.from({ length: 5 }, () => upload(nextLine)));
    assert.equal(await prisma.attendanceLog.count({ where: { deviceSn: sn } }), 2);

    await upload(line, otherSn);
    assert.equal(await prisma.attendanceLog.count({ where: { deviceSn: otherSn } }), 1);
    assert.equal(await upload(line, sn, 'OPERLOG'), 'OK');
    assert.equal(await upload(''), 'OK: 0');
    assert.equal(await prisma.attendanceLog.count({ where: { deviceSn: sn } }), 2);

    const stored = await prisma.attendanceLog.findFirstOrThrow({
      where: { deviceSn: sn, pin: '1001' },
    });
    assert.equal(stored.raw, line);
    assert.equal(stored.localTime.toISOString(), '2026-09-25T08:03:12.000Z');
    const clock = await prisma.$queryRaw<{ localClock: string }[]>`
      SELECT to_char("localTime", 'YYYY-MM-DD HH24:MI:SS') AS "localClock"
      FROM "AttendanceLog" WHERE "deviceSn" = ${sn} AND pin = '1001'
    `;
    assert.equal(clock[0].localClock, '2026-09-25 08:03:12');

    const result = await app.get(AttendanceService).saveBatch(sn, [
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
      'Attendance integration passed: persistence, mixed batches, concurrent deduplication, device isolation, counters, and terminal time.',
    );
  } finally {
    try {
      await prisma.attendanceLog.deleteMany({
        where: { deviceSn: { in: [sn, otherSn] } },
      });
    } finally {
      await app.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
