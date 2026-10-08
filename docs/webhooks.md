# Outgoing webhooks

Quick overview in the [root README](../README.md#webhooks). This is the full delivery contract.

The terminal's ADMS server address points to this server (`/iclock/*`).
`WEBHOOK_URL` points to the consuming application, which receives newly stored
attendance and final command results. Device handshake, polling, metadata,
intermediate command states, and raw terminal requests are not forwarded.

```dotenv
WEBHOOK_URL=https://app.example.com/api/webhooks/zk
WEBHOOK_SECRET=replace-with-a-shared-random-secret
WEBHOOK_POLL_INTERVAL_MS=1000
WEBHOOK_TIMEOUT_MS=10000
WEBHOOK_MAX_ATTEMPTS=10
```

URL and secret must be supplied together. HTTP and HTTPS are supported, without
credentials in the URL. Both empty disables creation of new events and pauses
pending deliveries without consuming attempts. There is no historical backfill:
replayed attendance and commands that already finished do not create events.
The API and worker must use the same settings. After changing settings, restart
both; existing deliveries use the worker's current startup URL and secret.
Within Docker, use a reachable HTTPS address or the consuming service's Compose
DNS name (for example `http://consumer:4000/api/webhooks/zk`). `localhost` inside
the worker refers to the worker container itself.

An event is inserted into PostgreSQL in the same transaction as its attendance
row or final command transition. A transaction failure returns the terminal's
existing HTTP 500 response so it can retry. The event ID, source key, and
serialized JSON body stay unchanged across delivery attempts and manual retries.
Photos, base64, full protocol payloads, and business rules are excluded.

```json
{
  "id": "6abbe2dc-c6c9-48ab-9a78-a53d7dcf30a7",
  "type": "attendance.created",
  "version": 1,
  "occurredAt": "2026-10-04T13:30:02.000Z",
  "data": {
    "attendanceId": 42,
    "sn": "ABC1234567890",
    "pin": "1001",
    "localTime": "2026-10-04 08:30:00",
    "status": 0,
    "verifyType": 15,
    "receivedAt": "2026-10-04T13:30:02.000Z"
  }
}
```

`localTime` is the device's wall clock **without a timezone**. The consumer knows
its device timezone and applies its business rules. `receivedAt` and
`occurredAt` are UTC server instants; for attendance they describe receipt.

`command.confirmed` and `command.failed` contain `commandId`, `type`,
`operationId`, `pin`, `sn`, `attempts`, `maxAttempts`, and nullable `returnCode`.
Generic commands have null operation/PIN. Failed events additionally contain
`reason`, including exhausted device errors, exhausted acknowledgement timeouts,
unavailable photo/payload, or failed prerequisites. Each command produces one
final event; duplicate/late ignored acknowledgements produce none. Command
timeouts and dependencies are still resolved on the next device poll.

The separate worker reserves up to five events in a short transaction with
`FOR UPDATE SKIP LOCKED`, then sends the batch concurrently outside that
transaction. Reservations consume attempts, including a crash before HTTP.
Each reservation has a unique token and a 60-second lease. Expired leases are
recovered; expired final attempts become failed. Token checks prevent an old
worker from overwriting a replacement's result. More than one worker can run.

Only HTTP 2xx confirms delivery. Redirects are not followed. Other responses,
network errors, and timeouts retry with exponential delays starting at five
seconds, positive jitter up to 20%, and a one-hour cap. The default budget is ten
total reservations, stored with each event; changing it affects new events.
`WEBHOOK_TIMEOUT_MS` accepts 1–30000, polling 1–60000, and max attempts 1–100.
Failed and delivered rows are retained. Logs contain delivery IDs, states,
attempts, HTTP codes, and error categories.

Start the worker after applying migrations:

```bash
docker compose build app webhook-worker
docker compose run --rm --no-deps app npx prisma migrate deploy
docker compose up -d app webhook-worker
docker compose logs -f webhook-worker
```

The runtime image uses `node dist/main.js` for HTTP and
`node dist/webhook-worker.js` for the worker (`npm run worker:prod`). Compose
uses `worker:dev`. Shutdown stops new reservations and waits for active HTTP
attempts before disconnecting PostgreSQL; Compose allows 40 seconds to stop.

### Verify and acknowledge an event

Each POST sends `Content-Type: application/json` plus:

- `X-ZK-Event-Id`: the stable event UUID.
- `X-ZK-Timestamp`: fresh Unix seconds for this attempt.
- `X-ZK-Signature`: `sha256=<hex HMAC-SHA256(secret, timestamp + "." + originalBody)>`.

Use the **raw request bytes**, compare signatures in constant time, and reject
timestamps outside a five-minute window. Delivery is **at least once** and may
be duplicated or arrive out of order. Deduplicate by event ID in the same
consumer transaction as application changes; acknowledge only after commit.
A receiver may commit successfully while its response or our completion write
is lost, causing another delivery with the same ID.

This Express example uses application-provided `consumerConfig`, `database`,
and `handleEvent` adapters. Install this raw-body route before any JSON parser
that would consume its body. The receipt table needs a unique event ID and an
atomic insert-if-absent operation:

```ts
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

app.post('/api/webhooks/zk', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const raw = req.body;
  const timestamp = req.get('X-ZK-Timestamp') ?? '';
  const supplied = req.get('X-ZK-Signature') ?? '';
  if (!Buffer.isBuffer(raw) || !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !/^sha256=[a-f0-9]{64}$/.test(supplied)) {
    return res.sendStatus(401);
  }
  const expected = createHmac('sha256', consumerConfig.webhookSecret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied.slice(7), 'hex'))) {
    return res.sendStatus(401);
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.sendStatus(400); }
  if (event.version !== 1 || typeof event.id !== 'string' ||
      event.id !== req.get('X-ZK-Event-Id')) return res.sendStatus(400);
  try {
    await database.transaction(async (tx) => {
      if (!await tx.receivedWebhook.insertIfAbsent(event.id)) return;
      await handleEvent(tx, event);
    });
    return res.sendStatus(204);
  } catch { return res.sendStatus(500); }
});
```

### Inspect and retry deliveries

All these routes require `X-API-Key: <API_KEY>`:

| Method | Path | Result |
|---|---|---|
| GET | `/api/webhooks/deliveries?status=failed&limit=50&cursor=...` | `{ items, nextCursor }`; body excluded from list |
| GET | `/api/webhooks/deliveries/:id` | Event and delivery metadata |
| POST | `/api/webhooks/deliveries/:id/retry` | 202; resets a failed delivery's attempt budget |

Status is optional (`pending`, `sending`, `delivered`, `failed`); limit defaults
to 50 with a maximum of 100. Pages sort by creation time and ID descending.
Use the opaque `nextCursor` to fetch the next page. Retry retains the original
ID/body/max attempts, resets attempts to zero, and schedules immediately. Missing
IDs return 404; retrying any state other than failed returns 409. Disabled
workers leave manually retried events pending until configured again.

