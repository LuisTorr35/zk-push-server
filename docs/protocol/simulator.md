# Terminal simulator

The CLI sends real HTTP requests to `/iclock/*`. It simulates ACK outcomes without
maintaining users/photos or performing facial recognition. It needs no API key,
database credentials, or server environment variables. Manual runs retain their
registered devices, attendance and command results on the server.

Run it inside the Node 22 development container. The production runtime image
contains the server/worker, not the TypeScript CLI and development dependencies.

## Start and register

Follow the [quick start](../../README.md#quick-start) and rebuild the development
image to include the simulator script:

```bash
docker compose build app
docker compose up -d app
docker compose exec app npm run simulate -- --help
docker compose exec app npm run simulate -- --scenario smoke --repeat 2 --polls 1
```

The smoke scenario performs handshake, sends synthetic OPTIONS, uploads the
same generated ATTLOG twice and polls once. Defaults are SN `ABC1234567890`,
PIN `1001` and server `http://localhost:3000`. Inside `exec app`, localhost reaches
the server in that same container. A separate container on the Compose network
would use `--url http://app:3000`. The URL must be an HTTP(S) origin without a
path, query, fragment or credentials.

OPTIONS identifies the simulator model/firmware and sends zero user/face counts;
these are synthetic metadata, not counts calculated from enrolled profiles.

## Attendance and exact retransmission

```bash
docker compose exec app npm run simulate -- \
  --scenario attendance --pin 1001 \
  --local-time '2026-10-04 08:30:00' --repeat 2

docker compose exec app npm run simulate -- \
  --scenario attendance --file test/fixtures/iclock/attlog-basic.txt --repeat 2
```

Without `--file`, one valid row uses status 0 and verification 15. The default
clock uses current UTC components as a **synthetic local-time value**, without
claiming a device timezone. Set `--local-time` to the wall clock you want to test.
The generated row/file is read once and reused byte-for-byte for every repeat.
Files preserve tabs, CRLF and even malformed rows to exercise the real parser.

`ATTLOG ... lines=N acknowledged` reports processed nonempty lines, not newly
created rows. Check AttendanceLog in Prisma Studio to verify identical keys were
stored once. Empty files correctly receive `OK: 0`.

## Enroll and confirm a profile

The preceding smoke run registers SN `ABC1234567890`. From the repository root,
use the application's configured API key in the following commands. The image
fixture is a generated solid-colour JPEG; it contains no person's photo and
exercises upload/delivery only. It is not suitable for real facial enrollment.

```bash
curl -X POST http://localhost:3000/api/persons \
  -H 'X-API-Key: <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"pin":"1001","name":"John Doe"}'

curl -X PUT http://localhost:3000/api/persons/1001/photo \
  -H 'X-API-Key: <API_KEY>' \
  -F 'photo=@test/fixtures/iclock/simulator-photo.jpg'

curl -X POST http://localhost:3000/api/persons/1001/enroll \
  -H 'X-API-Key: <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"deviceSns":["ABC1234567890"]}'

docker compose exec app npm run simulate -- --scenario poll --polls 2
```

Creation returns 201; upload returns 200; enrollment returns 202 with an operation
ID. On an empty device queue, two polls receive USERINFO and BIOPHOTO, with
`Return=0` ACKs after each. Existing higher-priority commands can require more
polls; use `--watch` when you want to keep consuming the queue. Logs show attempt
IDs and result codes, not payloads or image content.

Query the returned operation ID:

```bash
curl http://localhost:3000/api/persons/1001/operations/OPERATION_ID \
  -H 'X-API-Key: <API_KEY>'
```

The result should be `confirmed`. Synthetic success verifies the HTTP command
flow, not whether real firmware would accept the JPEG or recognize a face.
If PIN 1001 already exists, use its existing record or choose a different PIN
consistently for creation, upload and operations.

## Delete the terminal profile

```bash
curl -X POST http://localhost:3000/api/persons/1001/delete-profile \
  -H 'X-API-Key: <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"deviceSns":["ABC1234567890"]}'

docker compose exec app npm run simulate -- --scenario poll --polls 5
```

On an otherwise empty queue this confirms five deletion commands. The server
retains the Person and Photo. See [command formats](README.md#profile-command-formats)
for order and dependency behavior.

## Errors and timeouts

Queue another operation through the API before each test. To simulate terminal
errors, use any nonzero signed-32-bit code:

```bash
docker compose exec app npm run simulate -- \
  --scenario poll --ack error --return-code=-1004 --polls 6
```

Five errors exhaust the first command. A dependent enrollment photo fails
without being sent; deletion commands continue after their predecessor finishes.
The simulator exits 0 when requests and ACKs were accepted, even if the simulated
command result was nonzero. Query the operation to inspect its final result.

To withhold ACKs and let the server recover timeouts:

```bash
docker compose exec app npm run simulate -- \
  --scenario poll --ack none --watch --interval-ms 1000
```

The server's default deadline is 60 seconds. Polls before the deadline return
`OK`; later polls resend with a new attempt ID until five sends are exhausted.
For a faster **local test**, set `COMMAND_ACK_TIMEOUT_SECONDS=1` in `.env`, recreate
app with `docker compose up -d --force-recreate app`, then use
`--polls 6 --interval-ms 1100` instead of `--watch`. Restore the original timeout
and recreate app afterward. A finite run may end before pending commands finish;
remaining queue state is retained.

## Options and stopping

`--scenario` is `smoke`, `attendance`, or `poll`. Polling defaults to 10 queries
with a 1000 ms delay between completed queries. `--watch` replaces the finite
limit and cannot be combined with an explicit `--polls`. `--ack` is `success`,
`error`, or `none`; custom `--return-code` requires `--ack error`.
Use `--help` for all options. Every request times out after ten seconds, including
response-body reading. Requests are sequential and redirects are rejected.

Ctrl+C/SIGTERM cancels the current request or polling wait and exits 0. Argument,
file, network, HTTP, timeout and malformed-response failures exit 1. A disabled
Device returns HTTP 403; the simulator stops without re-enabling it. An
interrupted command remains queued/sent for the server to handle normally.

## Webhooks and automated verification

With WEBHOOK_URL and WEBHOOK_SECRET configured, new attendance and final command
results create outbox events. Run the webhook worker and inspect deliveries via
`/api/webhooks/deliveries` using X-API-Key. Replaying an identical attendance
batch produces no second event. See the [webhook guide](../webhooks.md)
for signing, receiver deduplication and configuration.

The simulator integration launches the real CLI against an HTTP server with
PostgreSQL `zk_push_test`, a synthetic JPEG and a local webhook receiver. It
checks registration, OPTIONS, retransmission, enrollment/deletion, error/timeout
exhaustion, disablement, SIGINT and signed event delivery. It cleans its own
records afterward; manual simulator runs do not clean up database records.

```bash
docker compose run --rm --no-deps \
  -e WEBHOOK_URL= -e WEBHOOK_SECRET= \
  -e DATABASE_URL=postgresql://zk:zk@postgres:5432/zk_push_test \
  app npx ts-node test/simulator.integration.ts
```
