# Development

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

## Simulator

Run a synthetic terminal through the current server's protocol:

```bash
docker compose build app
docker compose up -d app
docker compose exec app npm run simulate -- --scenario smoke --repeat 2 --polls 1
docker compose exec app npm run simulate -- --scenario poll --watch
```

The simulator sends real requests, accepts queued commands and returns simulated
success/error ACKs or withholds them to test timeouts. It logs attempt IDs rather
than payloads/photos and preserves its manually created records. It does not
maintain terminal profiles or emulate recognition. Use `--help` for options.

- [Protocol reference](protocol/README.md): routes, wire formats and implemented tables.
- [Physical terminal setup](protocol/device-setup.md): ADMS address/port and proxy routing.
- [Simulator walkthrough](protocol/simulator.md): attendance, duplicate batches, enrollment, deletion, errors and timeouts.

## Local S3 (MinIO)

Compose starts MinIO, an S3-compatible store used to try the photo backend
(console at http://localhost:9001, `minioadmin` / `minioadmin`). The local
initializer creates the private `zk-photos` bucket idempotently.
MinIO is built from the pinned official community source release because the
previous public image could not be downloaded. The first build takes longer;
subsequent builds reuse Docker's cache. See the
[official source release instructions](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z).
For database-only development, use `PHOTO_STORAGE=2` and start only Postgres/app.

## Tests

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
Simulator integration launches the actual CLI and checks registration, replay,
profile commands, error/timeout exhaustion, SIGINT, and signed event delivery.
Run it with `npx ts-node test/simulator.integration.ts` under the same test
configuration; `npm run test:integration` includes all five integration scripts.
Formatting and TypeScript checks also include `tools/**/*.ts`.

