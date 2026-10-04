# zk-push-server

Open source server for **ZKTeco** biometric terminals speaking the **ADMS / PUSH**
protocol (`/iclock/*`). It receives attendance punches, manages a command queue
towards the devices (enroll, delete users) and notifies your application through
webhooks.

> Status: work in progress (phase 6 — attendance and command webhooks).

## Why

ZK terminals running ADMS do not wait for the server to call them: **they call
the server** every few seconds over plain HTTP. Most public examples only
*receive* punches. This project covers the whole protocol:

- Attendance (`ATTLOG`), operation logs (`OPERLOG`) and photo uploads.
- Command queue with priorities, retries and device acknowledgements.
- Enrollment with photos stored in the database or S3-compatible storage;
  base64 is assembled when delivering a BIOPHOTO command.
- Signed webhooks towards your app, with retries (outbox pattern).
- Automatic device registration with enable/disable control stored in the database.
- Device simulator, so you can develop without the hardware.

It carries no business logic (memberships, shifts, permissions): your app
decides that when the webhook arrives. Works the same for a gym, an office or a
school.

## How it works

```
ZK terminal ──HTTP /iclock/*──▶ zk-push-server ──webhook──▶ Your app
                                     ▲
                    Your app ──REST──┘  (enroll, delete, query)
```

| The terminal says | Endpoint | The server |
|---|---|---|
| "Hello, I am SN X" | `GET /iclock/cdata` | Registers the device and returns its configuration |
| "This happened" | `POST /iclock/cdata?table=...` | Processes punches, operation logs and photos |
| "Anything for me?" | `GET /iclock/getrequest` | Hands over the next queued command, or `OK` |
| "Command done" | `POST /iclock/devicecmd` | Marks the command confirmed, or schedules a retry |

## Quick start

```bash
cp .env.example .env
# Set API_KEY to a random secret in .env, then build the application and local S3.
docker compose build
docker compose up -d postgres minio minio-init
docker compose run --rm --no-deps app npx prisma migrate deploy
docker compose up -d app webhook-worker
curl localhost:3000/health
```

This starts the server (port 3000), PostgreSQL (port 5433 on the host) and
MinIO, an S3-compatible store used to try the photo backend
(console at http://localhost:9001, `minioadmin` / `minioadmin`). The local
initializer creates the private `zk-photos` bucket idempotently.
MinIO is built from the pinned official community source release because the
previous public image could not be downloaded. The first build takes longer;
subsequent builds reuse Docker's cache. See the
[official source release instructions](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z).
For database-only development, use `PHOTO_STORAGE=2` and start only Postgres/app.

## Project layout

```
src/
  protocol/iclock/     ZK protocol adapter (parser + endpoints)
  modules/
    devices/           terminals and authorization
    persons/           people enrolled on the devices
    commands/          command queue (domain/ holds the rules)
    attendance/        punches
    webhooks/          notifications to your app (outbox)
  shared/
    config/            validated environment variables
    prisma/            database access
    storage/           photos: database, S3, or both
docs/protocol/         protocol documentation with examples
test/fixtures/         sample payloads (anonymized)
tools/simulator/       simulated terminal
```

## Roadmap

- [x] Phase 1 — NestJS skeleton + Docker Compose (Postgres, MinIO) + health check
- [x] Phase 2 — Protocol: handshake, getrequest, ATTLOG + parser with tests
- [x] Phase 3 — Devices with automatic registration and enable/disable control
- [x] Phase 4 — Command queue
- [x] Phase 5 — Persons API: enroll and delete
- [x] Phase 6 — Webhooks with outbox
- [ ] Phase 7 — Simulator, protocol docs and CI

## Devices

The `/iclock/*` routes do not require a session: terminals initiate requests to
this server and receive plain text responses. A valid `SN` automatically creates
an enabled device. Each request updates its connection IP and `lastSeenAt`.
The server uses the connection IP; forwarded headers are not trusted by default.

`Device.enabled` is read on every request. Setting it to `false` returns HTTP 403
with `DEVICE DISABLED` for handshake, uploads, polling, and command results.
Disabled devices still update their connection information but do not process
uploads. Connection updates never re-enable a device; setting `enabled` back to
`true` allows its next request without an application restart.

`OPTIONS` updates model, firmware, user count, and face count. Missing or invalid
fields preserve their previous values, and unknown counts remain null until
reported. Device names are initialized as `Device <SN>` and can be edited in
Prisma Studio without being overwritten by the terminal.

Apply existing migrations before starting the app, then open Prisma Studio to
edit the `Device` table:

```bash
docker compose build app
docker compose run --rm app npx prisma migrate deploy
docker compose run --rm -p 127.0.0.1:5555:5555 app npx prisma studio --hostname 0.0.0.0 --port 5555
```

Open `http://localhost:5555`, select `Device`, edit `enabled`, and save. Devices
with attendance rows cannot be deleted; disable them to preserve their history.
The device migration preserves existing attendance data and moves each serial
into a related `Device` row.

## Command queue

Inject `CommandsService` to enqueue an order for an existing, enabled device:

```ts
const { command, duplicate } = await commandsService.enqueue({
  deviceId: device.id,
  type: 'USERINFO_QUERY',
  payload: 'DATA QUERY USERINFO',
  priority: 0,
  dedupeKey: 'query:userinfo',
});
```

`dedupeKey` is optional. An existing pending or sent command with the same
`deviceId`, `type`, and key is returned with `duplicate: true`. Completed commands
allow a new order with that key. Enqueuing does not change connection timestamps.
There is no administrative HTTP API for commands yet.

`GET /iclock/getrequest?SN=ABC1234567890` delivers `C:<attemptId>:<payload>`.
Higher priorities are delivered first, then creation time and ID. A device has
at most one command in flight; additional polls return `OK` until a response
arrives or its deadline expires. Device row locks serialize queue operations,
and partial unique indexes enforce active deduplication and one sent command.

The ID sent to the terminal is a **CommandAttempt ID**, not the logical Command
ID. Each retry uses a new ID. `POST /iclock/devicecmd?SN=ABC1234567890` accepts
lines such as `ID=17&Return=0&CMD=DATA`; zero confirms the command, while other
codes requeue it until five total sends are exhausted. Commands then remain
`confirmed` or `failed`. Duplicate responses are ignored; the first response
for each attempt is retained. Unknown IDs, malformed lines, and responses from
another device are logged without changing the command.

`COMMAND_ACK_TIMEOUT_SECONDS` defaults to `60` and accepts positive integers up
to `86400`. Each delivery stores its deadline. The next poll recovers an expired
command or marks it failed after its fifth send; command timeouts are recovered only on device polling.
Queue state survives application restarts. An older unacknowledged attempt can
still confirm an active command, but its error cannot undo a newer send.
Timeout retries can execute an order more than once on the terminal; enqueued
orders should tolerate retransmission.

Results are persisted transactionally before returning `OK`; database failures
return HTTP 500 with plain text `ERROR`. Disabled devices cannot enqueue, receive,
or acknowledge commands. Payloads are not printed in command logs.

Generic payloads must be nonempty single lines; tab separators are supported.
Photo/profile operations use the persons API. BIOPHOTO commands store an
immutable photo reference rather than a base64 payload. The server loads the
bytes and builds the protocol text before atomically reserving a delivery.
Temporary storage failures return an error without consuming an attempt;
a permanently unavailable photo fails its command. Only IDs and result codes
are logged, never photo content.

## Persons and photos

`API_KEY` is required at startup. Every `/api/persons/*` request sends
`X-API-Key: <API_KEY>`. Terminal routes `/iclock/*` remain open: devices initiate
requests, register automatically, and are controlled through `Device.enabled`.
JSON/multipart parsing is isolated from the terminal's plain-text parser.

| Method | Path | Input / result |
|---|---|---|
| POST | `/api/persons` | `{ "pin": "1001", "name": "John Doe", "externalId": "optional" }` |
| GET | `/api/persons/:pin` | Person and photo metadata |
| PATCH | `/api/persons/:pin` | `name` and/or nullable `externalId`; PIN stays immutable |
| PUT | `/api/persons/:pin/photo` | Multipart field `photo`; returns updated person |
| GET | `/api/persons/:pin/photo` | Authenticated JPEG download |
| POST | `/api/persons/:pin/enroll` | `{ "deviceSns": ["ABC1234567890"] }` |
| POST | `/api/persons/:pin/delete-profile` | Same device list; retains person/photo on server |
| GET | `/api/persons/:pin/operations/:id` | Operation status and each command's result |

PINs are supplied by the consuming application, globally unique, and contain
1–24 alphanumeric characters. Names cannot contain tabs or newlines. Each
operation accepts 1–100 unique, existing, enabled device serials.

```bash
curl -X POST http://localhost:3000/api/persons \
  -H 'X-API-Key: <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"pin":"1001","name":"John Doe"}'

curl -X PUT http://localhost:3000/api/persons/1001/photo \
  -H 'X-API-Key: <API_KEY>' -F 'photo=@example.jpg'

curl -X POST http://localhost:3000/api/persons/1001/enroll \
  -H 'X-API-Key: <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"deviceSns":["ABC1234567890"]}'
```

Enrollment/deletion return HTTP **202** with operation and command IDs. This
means queued, not confirmed by the hardware. Poll the operation route for
`active`, `confirmed`, or `failed` and individual return codes/failure reasons.
Equivalent active requests reuse their operation; incompatible requests for
the same person/device return 409. All requested devices are queued atomically.

Enrollment queues USERINFO, then BIOPHOTO type 9 only after USERINFO succeeds.
A failed USERINFO also fails its dependent photo without sending it. Deletion
attempts BIODATA types 9, 2, 1, BIOPHOTO, then USERINFO. Each waits for the previous
step to finish, including failures, so unsupported biometric types cannot block
the remaining cleanup. Any failed step keeps the operation result `failed`.

Original uploads accept JPEG/PNG content up to **10 MiB**, independent of the
supplied extension or MIME type. Sharp applies EXIF orientation, strips metadata,
flattens transparency, and produces a JPEG without enlarging the image. It
tries maximum dimensions 600/480/360 with qualities 80/70/60/50/40 until the
file is at most **150 KiB (153600 bytes)**. An invalid or uncompressible image
is rejected. This limit applies to image bytes; the wire base64 is larger.

`PHOTO_STORAGE` controls new writes:

| Value | Mode | Database photo fields |
|---|---|---|
| `0` | Both | Binary `bytes`, `s3Bucket`, and `s3Key` |
| `1` | S3 (default) | Bucket/key, no binary copy |
| `2` | Database | Binary `bytes`, no bucket/key |

S3 stores the JPEG file; PostgreSQL stores optional `Bytes`, never base64.
Objects use immutable `photos/<uuid>.jpg` keys. The database retains object
keys rather than expiring URLs; the authenticated photo route serves the image.
Modes 0/1 require `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, and
`S3_SECRET_KEY`; region defaults to `us-east-1` and `S3_FORCE_PATH_STYLE` to
`true` (use `false` for providers requiring virtual-hosted addressing).
Inside Compose use `http://minio:9000`; from the host use `http://localhost:9000`.
External buckets must already exist; application requests never create them.

Both mode confirms only after S3 and the database transaction succeed. If the
transaction fails, the server attempts to delete the new object and logs failed
cleanup. Reads prefer S3 and fall back to the database, validating stored hashes.
Each photo retains its original locations, so switching the write mode does
not alter old photos; keep S3 credentials available when old S3 copies are read.
Updating a photo/name creates a new version. Existing commands keep their frozen
profile and photo, including retries. Old photo versions are retained; automatic
cleanup is not implemented.

API errors use JSON: 400 invalid input, 401 invalid key, 404 missing resource,
409 conflict/disabled target, 413 oversized upload, and 503 temporary storage
failure. Protocol errors retain their plain-text responses.

## Outgoing webhooks

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

## Attendance behavior and tests

`POST /iclock/cdata?SN=ABC1234567890&table=ATTLOG` saves valid rows and
returns `OK: <count>` after persistence completes. The count includes rejected
nonempty rows, so malformed rows do not cause endless retransmissions. Logs
report created, duplicate, and rejected rows. Database failures return HTTP 500
with plain text `ERROR`; invalid or missing serial numbers return HTTP 400
with `BAD SN`. `OPTIONS` updates device metadata; other tables are acknowledged but not processed yet.

`localTime` preserves the terminal's wall clock in a PostgreSQL timestamp
without time zone. Its JavaScript Date uses UTC components only for transport
through Prisma; it does not represent a converted UTC event instant.
Exact duplicates are identified by `(deviceId, pin, localTime)`.

Run parser and HTTP tests with `docker compose run --rm --no-deps app npm test -- --runInBand`.
For PostgreSQL integration tests, start Postgres and create a separate test
database once:

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U zk zk_push_test
docker compose run --rm --no-deps -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test app npx prisma migrate deploy
docker compose run --rm --no-deps -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test app npx ts-node test/attendance.integration.ts
docker compose run --rm --no-deps -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test app npx ts-node test/commands.integration.ts
# Persons/storage tests also need the local private bucket.
docker compose up -d minio minio-init
docker compose run --rm --no-deps -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test app npx ts-node test/persons.integration.ts
```

The integration scripts refuse any database name other than `zk_push_test` and
remove only their own generated records afterward. For integration runs, disable
external callbacks explicitly with `-e WEBHOOK_URL= -e WEBHOOK_SECRET=`. The
webhook test enables its own local HTTP receiver through injected configuration:

```bash
docker compose run --rm --no-deps -e WEBHOOK_URL= -e WEBHOOK_SECRET= -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test app npx ts-node test/webhooks.integration.ts
```

Webhook tests exercise real PostgreSQL transactions, a local HTTP receiver,
producer rollback, final command paths, exact signatures, retries, failed-only
replay, cursor pagination, concurrent reservations, and expired leases.
Attendance tests also verify concurrent device registration, OPTIONS updates, disable/reactivate
behavior, and the restriction on deleting devices with attendance history.
Command tests cover concurrent enqueuing/polling, priorities, retries, late and
duplicate responses, transaction rollback, and recovery after restarting the app.
Persons tests exercise all three storage modes against real PostgreSQL/MinIO,
fallback and compensation, API authentication/limits, atomic concurrent
operations, frozen snapshots, dependencies, and disablement during preparation.

## License

[MIT](LICENSE)
