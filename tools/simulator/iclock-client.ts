import { SimulatorError } from './options';

export type SimulatedCommand = { attemptId: number; payload: string };
export const REQUEST_TIMEOUT_MS = 10000;

export function parseCommand(body: string): SimulatedCommand | null {
  if (body === 'OK') return null;
  const match = /^C:([0-9]+):([^\r\n]+)$/.exec(body);
  const attemptId = Number(match?.[1]);
  if (!match || !Number.isInteger(attemptId) || attemptId < 1 || attemptId > 2147483647) {
    throw new SimulatorError('Unexpected command response');
  }
  return { attemptId, payload: match[2] };
}

/** HTTP-only adapter. It has no access to server services or persistence. */
export class IclockClient {
  constructor(
    private readonly origin: string,
    private readonly sn: string,
    private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async handshake(): Promise<void> {
    const body = await this.request('cdata');
    if (body.split(/\r?\n/)[0] !== `GET OPTION FROM: ${this.sn}`) {
      throw new SimulatorError('Unexpected handshake response');
    }
  }

  async metadata(): Promise<void> {
    const body = await this.request(
      'cdata',
      Buffer.from(
        'DeviceName=Simulator\r\nFWVersion=simulator\r\nUserCount=0\r\nFaceCount=0',
      ),
      'OPTIONS',
    );
    if (body !== 'OK: 1') throw new SimulatorError('Unexpected OPTIONS response');
  }

  async attendance(batch: Buffer): Promise<number> {
    const body = await this.request('cdata', batch, 'ATTLOG');
    const count = batch
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim()).length;
    if (body !== `OK: ${count}`) throw new SimulatorError('Unexpected ATTLOG response');
    // The ACK counts processed nonempty lines, including duplicates and rejected rows.
    return count;
  }

  async poll(): Promise<SimulatedCommand | null> {
    return parseCommand(await this.request('getrequest'));
  }

  async acknowledge(attemptId: number, returnCode: number): Promise<void> {
    const body = Buffer.from(`ID=${attemptId}&Return=${returnCode}&CMD=DATA`);
    const response = await this.request('devicecmd', body);
    if (response !== 'OK')
      throw new SimulatorError('Unexpected command acknowledgement response');
  }

  private async request(
    endpoint: string,
    body?: Buffer,
    table?: string,
  ): Promise<string> {
    this.signal.throwIfAborted();
    const url = new URL(`/iclock/${endpoint}`, this.origin);
    url.searchParams.set('SN', this.sn);
    if (table) url.searchParams.set('table', table);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        signal: AbortSignal.any([this.signal, timeout.signal]),
        ...(body === undefined
          ? {}
          : {
              headers: {
                'Content-Type':
                  endpoint === 'devicecmd'
                    ? 'application/x-www-form-urlencoded'
                    : 'text/plain',
              },
              body: new Uint8Array(body),
            }),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new SimulatorError(`HTTP ${response.status} at /iclock/${endpoint}`);
      }
      if (!/^text\/plain(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel().catch(() => undefined);
        throw new SimulatorError(`Unexpected content type at /iclock/${endpoint}`);
      }
      return await response.text();
    } catch (error) {
      if (this.signal.aborted) this.signal.throwIfAborted();
      if (error instanceof SimulatorError) throw error;
      throw new SimulatorError(
        timeout.signal.aborted
          ? `Request timed out at /iclock/${endpoint}`
          : `Network error at /iclock/${endpoint}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
