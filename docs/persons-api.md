# Persons and photos API

Quick overview in the [root README](../README.md#api). This is the full reference.

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

