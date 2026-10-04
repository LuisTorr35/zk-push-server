import { IclockClient, parseCommand } from './iclock-client';

const text = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
describe('simulator protocol client', () => {
  const fetcher = jest.fn();
  const controller = new AbortController();
  const client = () =>
    new IclockClient(
      'http://localhost:3000',
      'ABC1234567890',
      controller.signal,
      fetcher,
    );
  beforeEach(() => fetcher.mockReset());

  it('preserves the payload after the two envelope separators', () => {
    expect(parseCommand('C:17:DATA UPDATE USERINFO\tPIN=1001\tName=John: Doe')).toEqual({
      attemptId: 17,
      payload: 'DATA UPDATE USERINFO\tPIN=1001\tName=John: Doe',
    });
    expect(parseCommand('OK')).toBeNull();
  });
  it.each([
    'C:0:DATA',
    'C:2147483648:DATA',
    'C:abc:DATA',
    'C:17:',
    'C:17:DATA\nOTHER',
    'unexpected',
  ])('rejects malformed responses %s', (body) => {
    expect(() => parseCommand(body)).toThrow('Unexpected command response');
  });
  it('requires the matching handshake and plain-text response', async () => {
    fetcher.mockResolvedValueOnce(text('GET OPTION FROM: ABC1234567890\nDelay=10'));
    await client().handshake();
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'http://localhost:3000/iclock/cdata?SN=ABC1234567890',
    );
    fetcher.mockResolvedValueOnce(text('GET OPTION FROM: OTHER'));
    await expect(client().handshake()).rejects.toThrow('Unexpected handshake');
    fetcher.mockResolvedValueOnce(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(client().handshake()).rejects.toThrow('Unexpected content type');
  });
  it('sends exact file bytes and counts duplicates/rejected nonempty lines in the ACK', async () => {
    const batch = Buffer.from('1001\t2026-10-04 08:30:00\t0\t15\r\nbroken row\r\n\r\n');
    fetcher.mockResolvedValueOnce(text('OK: 2'));
    expect(await client().attendance(batch)).toBe(2);
    const [url, input] = fetcher.mock.calls[0];
    expect(String(url)).toContain('table=ATTLOG');
    expect(Buffer.from(input.body)).toEqual(batch);
    fetcher.mockResolvedValueOnce(text('OK: 1'));
    await expect(client().attendance(batch)).rejects.toThrow('Unexpected ATTLOG');
  });
  it('returns the received attempt ID in a form-style ACK', async () => {
    fetcher
      .mockResolvedValueOnce(text('C:41:DATA QUERY USERINFO'))
      .mockResolvedValueOnce(text('OK'));
    const command = await client().poll();
    await client().acknowledge(command!.attemptId, -1004);
    expect(String(fetcher.mock.calls[1][0])).toContain('/iclock/devicecmd?');
    expect(Buffer.from(fetcher.mock.calls[1][1].body).toString()).toBe(
      'ID=41&Return=-1004&CMD=DATA',
    );
    expect(fetcher.mock.calls[1][1].headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });
  it.each([302, 403, 500])(
    'fails on HTTP %s and never follows redirects',
    async (status) => {
      fetcher.mockResolvedValueOnce(
        new Response('private response', {
          status,
          headers: { Location: 'http://example.com' },
        }),
      );
      await expect(client().poll()).rejects.toThrow(`HTTP ${status}`);
      expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('hides network details', async () => {
    fetcher.mockRejectedValueOnce(new Error('private connection information'));
    await expect(client().poll()).rejects.toThrow('Network error at /iclock/getrequest');
  });
  it('times out a request while reading its response body', async () => {
    const hangingFetch = jest.fn(async (_url: unknown, input: RequestInit) => ({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      text: () =>
        new Promise((_resolve, reject) =>
          input.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    })) as unknown as typeof fetch;
    const shortClient = new IclockClient(
      'http://localhost:3000',
      'ABC1234567890',
      controller.signal,
      hangingFetch,
      20,
    );
    await expect(shortClient.poll()).rejects.toThrow('Request timed out');
  });
  it('aborts an in-flight request when stopped', async () => {
    const stop = new AbortController();
    const hangingFetch = jest.fn(
      (_url: unknown, input: RequestInit) =>
        new Promise((_resolve, reject) =>
          input.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    ) as unknown as typeof fetch;
    const stoppedClient = new IclockClient(
      'http://localhost:3000',
      'ABC1234567890',
      stop.signal,
      hangingFetch,
    );
    const pending = stoppedClient.poll();
    stop.abort();
    await expect(pending).rejects.toThrow();
    await expect(stoppedClient.poll()).rejects.toThrow();
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });
});
