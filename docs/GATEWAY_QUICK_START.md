# Program Transfer: server ↔ company laptop ↔ CNC machines

Your gateway is the company laptop or PC running Node-RED. One laptop can serve
many assigned machines that it can reach, or a laptop can serve one machine.
Both arrangements use the same API. The embedded team handles all communication
between that laptop and the CNC controllers.

The application has two everyday actions:

- **Send a program:** upload your local program to the server, then choose Send through
  the assigned laptop to the selected machine.
- **Backup Current Program:** ask the laptop to read that machine's actual
  running program and upload its contents to the server as a new backup.

Use `/api/programs/v3` for the web app and `/api/gateway/v1` for Node-RED.
The previous unversioned `/api/programs` and `/api/device/v1` flows have been
removed. For an existing installation, follow the [cutover check](GATEWAY_PROGRAM_TRANSFER_API.md#retiring-the-previous-device-flow)
before upgrading; resolve old pending work and retain saved files and history.

## Set up once

1. Register the laptop as a gateway and save its private gateway token in Node-RED.
2. Assign its machines. Each assignment has a machine ID, controller profile key
   and program path agreed with the embedded developer. Use `embedded` as the
   protocol label; controller addresses and credentials stay with that developer.
3. Node-RED requests the assigned machines and reports the operations it supports.

A company gateway can have several machine assignments. A gateway restricted to
one plant can only serve machines in that plant.

## How the laptop communicates

Node-RED makes outbound **HTTPS POST** requests to your application server.
It does not need a public laptop IP or an inbound port. **Socket.IO is only for
web-page status updates; Node-RED does not need it.** Existing MQTT machine
telemetry continues separately. Program file bytes use HTTPS.
Your developer calls these APIs from their existing Node-RED flow. Give them the
server HTTPS URL, their private gateway token and the assigned machine IDs.

Every gateway request includes:

```http
Authorization: Bearer <private-mxg-gateway-token>
```

Use `Content-Type: application/json` except for backup uploads, which use
`multipart/form-data`. Keep HTTPS certificate verification enabled.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/gateway/v1/config` | Read assignments and report supported operations |
| POST | `/api/gateway/v1/commands/next` | Wait for the next machine command |
| POST | `/api/gateway/v1/jobs/:id/file` | Download the saved program to send |
| POST | `/api/gateway/v1/jobs/:id/result` | Report completion or an error |
| POST | `/api/gateway/v1/jobs/:id/capture` | Upload actual machine backup contents |
| POST | `/api/gateway/v1/jobs/:id/progress` | Optional progress during an operation |

### 1. Read assignments and enable the two supported actions

Call `/config` with `{}`. The response contains `gateway` and `machines`.
Use the returned machine ID and `configuration_version` in subsequent reports.
After the embedded integration verifies upload and current-program reading:

```json
{"machines":[{"id":15,"configuration_version":1,"capabilities":{"upload":true,"current_backup":true,"list":false,"download":false,"restore":false},"limitations":[],"controller_status":"READY"}]}
```

Send that body to `/config`. Mark unsupported operations false and explain why
in `limitations`. Refresh configuration periodically; an empty `{}` request
reads assignments without replacing capability reports.

### 2. Wait for work

Call `/commands/next` with:

```json
{"wait_seconds":24,"available_slots":1,"active_job_ids":[]}
```

Keep one collection loop. The server can wait up to 24 seconds for work; use an
HTTP timeout above 30 seconds. If it returns
`{"job":null,"poll_seconds":15}`, pause 15 seconds before the next idle request.
Back off on connection errors.

A returned `job` includes `id`, `machine_id`, `controller_key`, `action`,
`program_path`, `lease_token` and `recovery_only`. Route it to the matching CNC
integration. Keep the lease private and send it on every request for that job.
For a simple one-at-a-time implementation, finish the current job before
collecting another. Never treat a repeated job ID as a new physical write.

## Send a program

1. The web page uploads the local file to
   `/api/programs/v3/machines/:id/uploads`, saving a server reference.
2. The page requests `/api/programs/v3/machines/:id/send`.
   Node-RED receives a job with `action:"SEND"` and file size/checksum metadata.
3. Node-RED calls `/api/gateway/v1/jobs/101/file`, substituting the real job ID:

```json
{"lease_token":"<lease-from-this-job>"}
```

4. Download the binary response and verify its SHA-256 against the command before
   handing it to the embedded integration. The embedded developer performs the CNC write,
   checks that writing is safe, and reads back the content to verify it.
5. Only after those checks, POST `/api/gateway/v1/jobs/101/result`:

```json
{"lease_token":"<lease-from-this-job>","status":"DONE","verified":true,"safety_checked":true,"sha256":"<actual-controller-read-back-sha256>","replaced":false}
```

The checksum must equal the queued file checksum. These flags report real checks;
downloading a file to the laptop does not mean it reached the CNC.
The web APIs use the user's JWT and separate idempotency keys, not the gateway
token. SEND requires `confirm:true`; overwriting follows the full contract below.

## Backup Current Program

1. The page requests `/api/programs/v3/machines/:id/backup`.
2. Node-RED receives `action:"BACKUP"` and `source:"CURRENT_RUNNING"`.
3. The embedded developer identifies and reads that CNC's actual running
   program, checking its identity remains valid during the read.
4. POST `/api/gateway/v1/jobs/102/capture` as multipart form data:

| Field | Example / required value |
| --- | --- |
| `lease_token` | Lease returned for this backup job |
| `type` | `CURRENT` |
| `program_name` | `O1001.nc`, the actual controller program name |
| `sha256` | SHA-256 of the actual uploaded bytes |
| `current_program_verified` | `true`, after controller-supported identification |
| `controller_reported_name` | Exactly the same value as `program_name` |
| `file` | The actual file bytes, as a multipart file part |

The server validates and saves the bytes, then completes the backup job.
Do not send a separate DONE result. Each new Backup click creates a new version.
A local example file or previous server upload is not a current-machine backup.

Report a failure using `/jobs/:id/result`, for example:

```json
{"lease_token":"<lease-from-this-job>","status":"FAILED","error_code":"PATH_NOT_FOUND","message":"The configured machine program path does not exist.","write_started":false}
```

Use `write_started:false` only when a write definitely did not start. For progress,
POST `{"lease_token":"<lease>","stage":"READING","bytes":512,"total":2048}` to
`/jobs/:id/progress`. See the [full API contract](GATEWAY_PROGRAM_TRANSFER_API.md)
for retries, unknown write outcomes, `recovery_only`, replacement backups,
checksum proof, timeouts and unsupported-controller errors. Live CNC reading and
writing remain the embedded team's integration responsibility.

## File browser actions

The page shows **Server files** and **Machine files** side by side. Upload adds a
server copy; select it and choose **Send to machine** to request delivery. If
Node-RED reports `list:true`, the page can request a `LIST` command and show the
real machine directory. If it reports `download:true`, selecting a machine file
and choosing **Retrieve to server** requests a `FETCH` command; upload its bytes
as a `FETCHED` capture. These actions use the same command, result and capture
endpoints. Current-program backup always reads the actual running program,
independently of the file selected in either pane.
