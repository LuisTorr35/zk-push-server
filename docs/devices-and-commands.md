# Devices, command queue and attendance

How the server handles terminals internally. For the wire format see the [protocol reference](protocol/README.md).

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

## Attendance

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

