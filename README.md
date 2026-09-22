# zk-push-server

Open source server for **ZKTeco** biometric terminals speaking the **ADMS / PUSH**
protocol (`/iclock/*`). It receives attendance punches, manages a command queue
towards the devices (enroll, delete users) and notifies your application through
webhooks.

> Status: work in progress (phase 1 — skeleton).

## Why

ZK terminals running ADMS do not wait for the server to call them: **they call
the server** every few seconds over plain HTTP. Most public examples only
*receive* punches. This project covers the whole protocol:

- Attendance (`ATTLOG`), operation logs (`OPERLOG`) and photo uploads.
- Command queue with priorities, retries and device acknowledgements.
- Enrollment with photo (base64 in the database or S3-compatible storage).
- Signed webhooks towards your app, with retries (outbox pattern).
- Allow-list of authorized terminals.
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
docker compose up -d
curl localhost:3000/health
```

This starts the server (port 3000), PostgreSQL (port 5433 on the host) and
MinIO, an S3-compatible store used to try the `s3` photo backend
(console at http://localhost:9001, `minioadmin` / `minioadmin`).

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
    storage/           photos: database or S3
docs/protocol/         protocol documentation with examples
test/fixtures/         sample payloads (anonymized)
tools/simulator/       simulated terminal
```

## Roadmap

- [x] Phase 1 — NestJS skeleton + Docker Compose (Postgres, MinIO) + health check
- [ ] Phase 2 — Protocol: handshake, getrequest, ATTLOG + parser with tests
- [ ] Phase 3 — Devices and authorization allow-list
- [ ] Phase 4 — Command queue
- [ ] Phase 5 — Persons API: enroll and delete
- [ ] Phase 6 — Webhooks with outbox
- [ ] Phase 7 — Simulator, protocol docs and CI

## License

[MIT](LICENSE)
