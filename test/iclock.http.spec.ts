import { configureBodyParsers } from '../src/shared/http/body-parsers';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IclockModule } from '../src/protocol/iclock/iclock.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { CommandsService } from '../src/modules/commands/commands.service';

describe('Iclock HTTP', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const createMany = jest.fn();
  const upsert = jest.fn();
  const update = jest.fn();
  const next = jest.fn();
  const respond = jest.fn();
  const line = '1001\t2026-09-25 08:03:12\t0\t15';

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [IclockModule] })
      .overrideProvider(PrismaService)
      .useValue({ attendanceLog: { createMany }, device: { upsert, update } })
      .overrideProvider(CommandsService)
      .useValue({ next, respond })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureBodyParsers(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    next.mockReset();
    respond.mockReset();
    next.mockResolvedValue(null);
    respond.mockResolvedValue(undefined);
    createMany.mockReset();
    upsert.mockReset();
    update.mockReset();
    upsert.mockResolvedValue({ id: 1, sn: 'ABC1234567890', enabled: true });
    update.mockResolvedValue({ id: 1 });
    createMany.mockResolvedValue({ count: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a plain text handshake and an empty queue', async () => {
    const handshake = await fetch(`${baseUrl}/iclock/cdata?SN=ABC1234567890`);
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get('content-type')).toContain('text/plain');
    expect(await handshake.text()).toContain('GET OPTION FROM: ABC1234567890');
    const queue = await fetch(`${baseUrl}/iclock/getrequest?SN=ABC1234567890`);
    expect(await queue.text()).toBe('OK');
  });

  it.each(['cdata', 'getrequest', 'devicecmd'])(
    'rejects a missing SN at %s with plain text',
    async (endpoint) => {
      const response = await fetch(`${baseUrl}/iclock/${endpoint}`, {
        method: endpoint === 'devicecmd' ? 'POST' : 'GET',
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('BAD SN');
    },
  );

  it.each(['SN=bad%0Aserial', 'SN=ABC&SN=DEF', 'SN='])(
    'rejects invalid serial query %s',
    async (query) => {
      const response = await fetch(`${baseUrl}/iclock/cdata?${query}`, {
        method: 'POST',
        body: line,
      });
      expect(response.status).toBe(400);
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it('stores only valid rows and preserves terminal clock components and raw data', async () => {
    const response = await fetch(
      `${baseUrl}/iclock/cdata?SN=ABC1234567890&table=attlog`,
      {
        method: 'POST',
        body: `${line}\r\n1002\t2026-02-31 08:03:12\t0\t15\r\n`,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK: 2');
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          deviceId: 1,
          pin: '1001',
          localTime: new Date('2026-09-25T08:03:12Z'),
          status: 0,
          verifyType: 15,
          raw: line,
        },
      ],
      skipDuplicates: true,
    });
  });

  it.each(['', 'broken row'])(
    'acknowledges a batch without valid rows %j',
    async (body) => {
      const response = await fetch(
        `${baseUrl}/iclock/cdata?SN=ABC1234567890&table=ATTLOG`,
        {
          method: 'POST',
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body ? 'OK: 1' : 'OK: 0');
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it('does not persist other tables as attendance', async () => {
    const response = await fetch(
      `${baseUrl}/iclock/cdata?SN=ABC1234567890&table=OPERLOG`,
      {
        method: 'POST',
        body: line,
      },
    );
    expect(await response.text()).toBe('OK');
    expect(createMany).not.toHaveBeenCalled();
  });

  it('waits for persistence before acknowledging the upload', async () => {
    let finish!: (result: { count: number }) => void;
    let acknowledged = false;
    createMany.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = fetch(`${baseUrl}/iclock/cdata?SN=ABC1234567890&table=ATTLOG`, {
      method: 'POST',
      body: line,
    }).then((response) => {
      acknowledged = true;
      return response;
    });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acknowledged).toBe(false);
    finish({ count: 1 });
    expect(await (await pending).text()).toBe('OK: 1');
  });

  it('returns plain text 500 on persistence failure without exposing database details', async () => {
    createMany.mockRejectedValue(new Error('database connection details'));
    const response = await fetch(
      `${baseUrl}/iclock/cdata?SN=ABC1234567890&table=ATTLOG`,
      {
        method: 'POST',
        body: line,
      },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('ERROR');
  });
  it.each([
    ['GET', 'cdata', ''],
    ['POST', 'cdata', '&table=ATTLOG'],
    ['POST', 'cdata', '&table=OPTIONS'],
    ['GET', 'getrequest', ''],
    ['POST', 'devicecmd', ''],
  ])('rejects a disabled device at %s %s %s', async (method, endpoint, query) => {
    upsert.mockResolvedValue({ id: 1, enabled: false });
    const response = await fetch(
      `${baseUrl}/iclock/${endpoint}?SN=ABC1234567890${query}`,
      {
        method,
        ...(method === 'POST' ? { body: line } : {}),
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('DEVICE DISABLED');
    expect(createMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('registers device connections without altering their enabled flag', async () => {
    await fetch(`${baseUrl}/iclock/cdata?SN=ABC1234567890`);
    expect(upsert).toHaveBeenCalledWith({
      where: { sn: 'ABC1234567890' },
      create: {
        sn: 'ABC1234567890',
        name: 'Device ABC1234567890',
        ip: '127.0.0.1',
        lastSeenAt: expect.any(Date),
      },
      update: { ip: '127.0.0.1', lastSeenAt: expect.any(Date) },
    });
  });

  it('updates OPTIONS metadata without creating attendance rows', async () => {
    const response = await fetch(
      `${baseUrl}/iclock/cdata?SN=ABC1234567890&table=OPTIONS`,
      {
        method: 'POST',
        body: '~DeviceName=Example Device,FWVersion=1.0\r\nUserCount=0\r\nFaceCount=12',
      },
    );
    expect(await response.text()).toBe('OK: 1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        model: 'Example Device',
        firmware: '1.0',
        userCount: 0,
        faceCount: 12,
      },
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('returns 500 if registering the device fails', async () => {
    upsert.mockRejectedValue(new Error('database unavailable'));
    const response = await fetch(`${baseUrl}/iclock/cdata?SN=ABC1234567890`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('ERROR');
  });
  it('returns an attempt ID and command payload from getrequest', async () => {
    next.mockResolvedValue({ id: 17, commandId: 9, payload: 'DATA QUERY USERINFO' });
    const response = await fetch(`${baseUrl}/iclock/getrequest?SN=ABC1234567890`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('C:17:DATA QUERY USERINFO');
    expect(next).toHaveBeenCalledWith(1);
  });

  it('passes valid result lines to the queue before acknowledging the batch', async () => {
    const response = await fetch(`${baseUrl}/iclock/devicecmd?SN=ABC1234567890`, {
      method: 'POST',
      body: 'ID=17&Return=0&CMD=DATA\r\nbroken\r\nID=18&Return=-1004',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(respond).toHaveBeenCalledWith(1, [
      { id: 17, returnCode: 0 },
      { id: 18, returnCode: -1004 },
    ]);
  });

  it.each(['getrequest', 'devicecmd'])(
    'returns 500 if the queue fails at %s',
    async (endpoint) => {
      next.mockRejectedValue(new Error('database unavailable'));
      respond.mockRejectedValue(new Error('database unavailable'));
      const response = await fetch(`${baseUrl}/iclock/${endpoint}?SN=ABC1234567890`, {
        method: endpoint === 'devicecmd' ? 'POST' : 'GET',
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('ERROR');
    },
  );
});
