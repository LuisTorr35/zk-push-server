# zk-push-server

Open source server for **ZKTeco** biometric terminals speaking the **ADMS / PUSH**
protocol (`/iclock/*`). It receives attendance punches, manages a command queue
towards the devices (enroll, delete users) and notifies your application through
webhooks.

> Status: work in progress (phase 5 — persons, photos, and enrollment).

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
docker compose up -d app
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
- [ ] Phase 6 — Webhooks with outbox
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
command or marks it failed after its fifth send; there is no background worker.
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
cleanup and webhooks belong to later phases.

API errors use JSON: 400 invalid input, 401 invalid key, 404 missing resource,
409 conflict/disabled target, 413 oversized upload, and 503 temporary storage
failure. Protocol errors retain their plain-text responses.

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
remove only their own generated records afterward.
Attendance tests also verify concurrent device registration, OPTIONS updates, disable/reactivate
behavior, and the restriction on deleting devices with attendance history.
Command tests cover concurrent enqueuing/polling, priorities, retries, late and
duplicate responses, transaction rollback, and recovery after restarting the app.
Persons tests exercise all three storage modes against real PostgreSQL/MinIO,
fallback and compensation, API authentication/limits, atomic concurrent
operations, frozen snapshots, dependencies, and disablement during preparation.

## License

[MIT](LICENSE)
