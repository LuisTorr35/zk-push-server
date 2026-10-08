# zk-push-server

Open source server for **ZKTeco** biometric terminals speaking the **ADMS / PUSH**
protocol (`/iclock/*`). It receives attendance punches, enrolls and deletes people
on the devices, and notifies your application through signed webhooks.

```
ZK terminal ──HTTP /iclock/*──▶ zk-push-server ──webhook──▶ Your app
                                     ▲
                    Your app ──REST──┘  (enroll, delete, query)
```

It carries no business logic (memberships, shifts, permissions): your app
decides that when the webhook arrives.

## Quick start

**1. Configure**

```bash
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | Value |
|---|---|
| `API_KEY` | Random secret your app sends as `X-API-Key` |
| `WEBHOOK_URL` | Endpoint in your app that receives events |
| `WEBHOOK_SECRET` | Shared secret used to sign each webhook |

Leave both webhook variables empty to disable webhooks.

Choose where photos are stored:

- **S3 bucket** (default, `PHOTO_STORAGE=1`): fill in `S3_ENDPOINT`, `S3_BUCKET`,
  `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `S3_REGION`. The bucket must already exist.
  Use `S3_FORCE_PATH_STYLE=false` for AWS S3.
- **Database** (`PHOTO_STORAGE=2`): photos are kept in PostgreSQL; no S3 variables needed.
- **Local S3 for testing**: point the S3 variables to the bundled MinIO
  (`S3_ENDPOINT=http://minio:9000`, `S3_BUCKET=zk-photos`, both keys `minioadmin`,
  `S3_FORCE_PATH_STYLE=true`) and run `docker compose up -d minio minio-init`.

**2. Start**

```bash
docker compose build app webhook-worker
docker compose up -d postgres
docker compose run --rm --no-deps app npx prisma migrate deploy
docker compose up -d app webhook-worker
curl localhost:3000/health
```

**3. Point the terminal at the server**

On the terminal, set the ADMS / cloud server address to this host and port 3000
(or your public proxy). It registers itself on its first request. See
[physical terminal setup](docs/protocol/device-setup.md).

No hardware? Use the simulator:

```bash
docker compose exec app npm run simulate -- --scenario smoke
```

## Webhooks

Your app receives a `POST` with a JSON body for each new event:

| Event | When |
|---|---|
| `attendance.created` | A person punched on a terminal |
| `command.confirmed` | The terminal applied an enroll/delete command |
| `command.failed` | The command failed after its retries (includes `reason`) |

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

`localTime` is the terminal's wall clock **without a timezone**; apply your
device's timezone on your side.

To verify each request, compute
`HMAC-SHA256(WEBHOOK_SECRET, X-ZK-Timestamp + "." + rawBody)` and compare it with
the `X-ZK-Signature` header (`sha256=<hex>`). Respond with any 2xx to
acknowledge. Other responses retry with exponential backoff.

Delivery is **at least once**, so deduplicate by `id`.

Full contract, a receiver example and retry details: [docs/webhooks.md](docs/webhooks.md).

## API

Every `/api/*` request needs the header `X-API-Key: <API_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/persons` | Create a person: `{ "pin": "1001", "name": "John Doe" }` |
| PUT | `/api/persons/:pin/photo` | Upload a face photo (multipart field `photo`) |
| POST | `/api/persons/:pin/enroll` | Send the person to devices: `{ "deviceSns": ["ABC1234567890"] }` |
| POST | `/api/persons/:pin/delete-profile` | Remove the person from those devices |
| GET | `/api/persons/:pin/operations/:id` | Check whether an enroll/delete finished |
| GET | `/api/webhooks/deliveries?status=failed` | List webhook deliveries |
| POST | `/api/webhooks/deliveries/:id/retry` | Retry a failed delivery |

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

Enroll and delete return **202**: the command is queued, not yet applied. The
result arrives as a `command.*` webhook, or you can poll the operation route.

Full reference (limits, photo storage, errors): [docs/persons-api.md](docs/persons-api.md).

## Documentation

- [Webhooks](docs/webhooks.md): payloads, signatures, retries, delivery inspection.
- [Persons API](docs/persons-api.md): endpoints, photo processing and storage modes.
- [Devices, commands and attendance](docs/devices-and-commands.md): enabling devices, command queue, duplicates.
- [Protocol reference](docs/protocol/README.md): `/iclock/*` routes and wire formats.
- [Terminal setup](docs/protocol/device-setup.md): ADMS address and proxy routing.
- [Simulator walkthrough](docs/protocol/simulator.md): try every flow without hardware.
- [Development](docs/development.md): project layout and tests.

## License

[MIT](LICENSE)
