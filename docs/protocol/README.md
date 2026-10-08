# ADMS / PUSH implemented by this server

This describes the current implementation. A terminal initiates every request;
the server returns configuration or queued commands in the HTTP response.
The server does not connect to the terminal. All examples use synthetic data.

- [Configure a physical terminal](device-setup.md)
- [Run the simulator and a complete enrollment flow](simulator.md)
- [Consumer API and signed webhooks](../webhooks.md)

## HTTP routes and supported data

| Method | Path | Result |
|---|---|---|
| GET | `/iclock/cdata?SN=ABC1234567890` | Configuration text and automatic device registration |
| POST | `/iclock/cdata?SN=ABC1234567890&table=ATTLOG` | Attendance persistence, then `OK: <nonempty lines>` |
| POST | `/iclock/cdata?SN=ABC1234567890&table=OPTIONS` | Device metadata update, then `OK: 1` |
| GET | `/iclock/getrequest?SN=ABC1234567890` | One `C:<attemptId>:<payload>` or `OK` |
| POST | `/iclock/devicecmd?SN=ABC1234567890` | Record command results, then `OK` |

`SN` is required: 1–64 alphanumeric characters, with surrounding whitespace
trimmed. Serial numbers are case-sensitive. Terminal routes accept requests
without API keys. Each connection creates an enabled device if needed and
updates its IP/last-seen timestamp. `Device.enabled` controls processing.

Upload table names are trimmed and case-insensitive. Only ATTLOG and OPTIONS
are processed. OPERLOG, ATTPHOTO, BIOPHOTO and other tables currently receive
`OK` without persisting their content. Outgoing BIOPHOTO commands are supported;
incoming terminal photo uploads are not implemented.

Bodies under `/iclock` are read as UTF-8 text, including those labelled
`application/x-www-form-urlencoded`, with a 25 MiB request limit. Success is
HTTP 200 with `Content-Type: text/plain`; responses are not JSON.

## Handshake

```http
GET /iclock/cdata?SN=ABC1234567890 HTTP/1.1
```

The current response is:

```text
GET OPTION FROM: ABC1234567890
ATTLOGStamp=None
OPERLOGStamp=9999
ErrorDelay=30
Delay=10
TransInterval=1
TransFlag=TransData AttLog OpLog EnrollUser ChgUser UserPic
Realtime=1
Encrypt=None
```

These are the advertised settings, not a statement that every advertised table
has a handler. Stamps are fixed; the server does not maintain synchronization
cursors. Actual polling behavior depends on terminal firmware.

## Attendance: ATTLOG

Fields are separated by literal TAB bytes, and rows by LF or CRLF. In the
notation below, `<TAB>` is byte `09`; `<CR><LF>` is bytes `0d 0a`. These markers
are explanations and must not be transmitted as literal text.

```text
1001<TAB>2026-10-04 08:30:00<TAB>0<TAB>15<TAB>0<TAB>0<CR><LF>
1002<TAB>2026-10-04 08:35:00<TAB>1<TAB>1<TAB>0<TAB>0<CR><LF>
```

| Position | Meaning in this implementation |
|---|---|
| 1 | PIN: 1–24 alphanumeric characters |
| 2 | Valid calendar time `YYYY-MM-DD HH:mm:ss`, years 0001–9999 |
| 3 | Status: nonnegative signed-32-bit integer |
| 4 | Verification type: nonnegative signed-32-bit integer |
| 5 onward | Uninterpreted extra fields retained in the raw row |

Status and verification numbers are preserved; business rules and the meaning
of model-specific values belong to the consumer. Empty/whitespace-only lines
are ignored. Invalid rows are rejected while valid rows in the same batch are
saved. The response counts every nonempty row, including rejected and duplicate
rows, so `OK: 2` does not mean two new database records.

The unique key is `(deviceId, pin, localTime)`. Identical retransmissions do not
create new attendance rows or new attendance events. Different status/verify
values at the same key also remain duplicates.

The timestamp is a terminal wall clock **without timezone**. PostgreSQL retains
its components; the JavaScript Date's UTC encoding is only transport through
Prisma. The consumer applies the device timezone. `receivedAt` is server UTC.
Anti-double-punch windows are consumer logic; only exact keys are deduplicated.

Send a fixture containing actual tabs from the repository root:

```bash
curl -i -X POST 'http://localhost:3000/iclock/cdata?SN=ABC1234567890&table=ATTLOG' \
  -H 'Content-Type: text/plain' \
  --data-binary @test/fixtures/iclock/attlog-basic.txt
```

## Device metadata: OPTIONS

The server accepts `key=value` pairs separated by newlines or commas. Supported
keys are `~DeviceName`/`DeviceName` (stored as model), `FWVersion`, `UserCount`,
and `FaceCount`. Counts must be nonnegative signed-32-bit integers. Unknown,
empty and invalid values leave existing metadata unchanged. The editable device
name and enabled flag are preserved.

```text
DeviceName=Simulator<CR><LF>
FWVersion=simulator<CR><LF>
UserCount=0<CR><LF>
FaceCount=0<CR><LF>
```

OPTIONS creates no attendance or webhook event and returns `OK: 1`, including
when no supported values were present.

## Polling and command results

An empty queue returns `OK`. A queued order returns a single line, for example:

```text
C:17:DATA QUERY USERINFO
```

`17` identifies a **CommandAttempt**, not the logical Command. A retry receives
a new attempt ID. Parse only the first two colon separators; values in the
payload may contain additional colons. Payload fields often use literal tabs.
Priority descending, creation time ascending, then ID determine delivery order,
subject to prerequisites. There is at most one sent command per device.

Results use ampersand-separated `key=value` fields. Multiple results can be
separated by LF or CRLF. `CMD` is optional and ignored; ID and Return are required.

```text
ID=17&Return=0&CMD=DATA<CR><LF>
ID=18&Return=-1004&CMD=DATA<CR><LF>
```

ID must be a positive signed-32-bit integer; Return is a signed-32-bit integer.
Duplicate field names invalidate a row. Unknown extra fields are ignored.
Zero confirms the logical command. Any nonzero value retries it until its fifth
send, then fails it; `-1004` in examples is a synthetic nonzero test code, not a
universal firmware error definition.

The first valid response per owned attempt is retained. Duplicate responses,
unknown IDs and IDs belonging to another device do not change command state.
An older unacknowledged success can confirm an active command. Older errors
cannot undo a newer send. Confirmed/failed commands remain terminal.

Without an ACK, the next poll after the stored deadline recovers the command.
`COMMAND_ACK_TIMEOUT_SECONDS` defaults to 60. Five total sends are allowed,
including retries. Intermediate polls return `OK`. Timeouts are recovered by
device polling, not by the webhook worker.

## Profile command formats

These escaped examples use `\t` to illustrate a literal TAB. Enqueue typed
profile operations through `/api/persons`; do not send the escaped strings.

Enrollment first sends USERINFO:

```text
DATA UPDATE USERINFO\tPIN=1001\tName=John Doe\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000100000000\tVerify=-1
```

Only after its confirmation does BIOPHOTO become eligible:

```text
DATA UPDATE BIOPHOTO\tPIN=1001\tFileName=1001.jpg\tType=9\tSize=<byte-count>\tContent=<base64-of-jpeg>
```

`Size` counts decoded JPEG bytes, at most 150 KiB (153600 bytes). The base64 wire
text is larger. Sharp prepares API uploads; storage holds binary bytes and/or an
S3 object reference. Commands retain immutable photo/profile references, and
base64 is rendered at delivery rather than stored in the queue. Placeholders
above are not valid wire content. Firmware support for these orders still
requires verification on the target model.

Deletion attempts these five steps in order, waiting for the preceding command
to finish even if it failed:

```text
DATA DELETE biodata Pin=1001\tType=9
DATA DELETE biodata Pin=1001\tType=2
DATA DELETE biodata Pin=1001\tType=1
DATA DELETE biophoto PIN=1001
DATA DELETE USERINFO PIN=1001
```

One unsupported type therefore does not prevent later cleanup attempts. The
operation remains failed if any command failed. Deletion removes the terminal
profile; it retains the server's Person and Photo records.

## Responses, transactions and events

| HTTP status | Meaning / response |
|---|---|
| 200 | Normal plain-text protocol response |
| 400 | Missing/invalid SN: `BAD SN` |
| 403 | Registered device disabled: `DEVICE DISABLED` |
| 413 | Body exceeds the protocol request limit |
| 500 | Persistence/preparation failure: `ERROR` |

Attendance and its new events commit together. Each final command transition
and its event also commit together, including an entire ACK batch. Database
failures roll back the transaction before the server responds. The terminal
can retransmit; previously committed identical attendance remains deduplicated.

With webhooks enabled, `attendance.created`, `command.confirmed` and
`command.failed` are queued in an outbox and delivered by a separate process.
Requests themselves are not forwarded. See the [webhook contract](../webhooks.md)
for signature verification, consumer deduplication and delivery retries.
