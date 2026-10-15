# Program Transfer: acknowledged delivery and fresh backup

## Operator flow

1. Choose the CNC machine in **Program Transfer**. Save its **Machine IP** and **Program path** on this page. Create its device token once and install it privately on the device.
2. **Upload and send** saves an immutable server reference and requests delivery to that machine. The file stays on the server even if delivery fails. “Saved” and “Confirmed by machine” are different states.
3. **Backup** requests a new read of the program currently selected/running on the CNC at execution time. Every completed request saves a distinct server backup. **Download** retrieves an already saved file.

The device reaches the server through outbound HTTPS requests; no factory-side inbound port is required. Uploading never starts a CNC program. The device must check its controller's permitted operating mode before writing and verify the bytes by reading them back.

## Deployment and compatibility

Apply pending migrations through the guarded `npm run migrate` runner before deploying the updated API/collector. This flow needs `039_program_current.sql`, `040_program_commands.sql`, and `041_program_tenant_integrity.sql`. Review `npm run migrate -- --status` first. Normal migrations exclude the retired destructive 003 reset. Baseline only an already verified schema with `--baseline --through <last-verified-file>`.

New commands use `protocol_version=2`. Existing GET `/jobs/next` clients consume only legacy protocol 1 jobs. Update the device client; telemetry publishing alone does not implement the command consumer. A queued command expires after five minutes; a claimed command expires after fifteen minutes. Check the controller before retrying a timed-out write.

The reference [Python agent](../tools/program-agent/program_agent.py) implements durable command handling and retry logic using only the Python standard library. Its `FolderController` is explicitly a test fixture: set `CNC_DIR` and `CNC_ACTIVE_PROGRAM` to a real file in that test folder. Physical Fanuc/FOCAS, Mitsubishi, Siemens, or FTP adapters are not included. Implement the adapter's `read_current(path)`, `read`, `write`, and operational write-safety checks using the controller's actual APIs. Never infer the running program from the newest server file, first directory entry, or last uploaded filename.

## Authentication

Web requests use the signed-in user's JWT. Device requests use that machine's `mxd_...` token:

```text
Authorization: Bearer <device_token>
X-Agent-Version: 2.0.0
```

The token is stored as a hash on the server, belongs to one machine/company, and is invalidated when replaced/revoked. MQTT credentials and the HTTP device token have different roles. Do not share one global device password across companies.

## Web API

| Request | Body / result |
|---|---|
| `PUT /api/programs/machines/{id}/connection` | JSON `{"ip_address":"192.168.1.7","program_path":"//CNC_MEM/USER/PATH1/"}`. Saves validated connection settings; cannot change them while an operation is pending. Requires machine edit and Program Transfer view. |
| `POST /api/programs/machines/{id}/transfer` | Multipart `file`, optional `program_name`, `note`, and `overwrite=true` only after explicit replacement confirmation. `201 {"data":{"file":{...},"job":{...}}}`. Requires upload and transfer. |
| `POST /api/programs/machines/{id}/backup` | Empty JSON. `201 {"data":{"job":{...}}}`. Requires fetch permission. No filename is supplied: the device resolves the current program. |
| `GET /api/programs/machines/{id}/status` | Current server reference, newest saved backup, connection state, and latest SEND/BACKUP states. This does not assert which program is running. |
| `GET /api/programs/files?machine_id={id}&page=1&limit=25` | Saved versions, loaded only when history is opened. |
| `GET /api/programs/files/{file_id}/download` | Saved file bytes. |

Send a unique `Idempotency-Key` of 16–80 letters/digits/hyphens/underscores with Upload or Backup. Reuse it after a lost HTTP reply; use a new key for a new operator action. Reusing a key with different file bytes/name/replacement choice returns `409 REQUEST_CONFLICT`.

Saved IP/path and an active device token are required. An offline device can receive a queued request after reconnecting before the deadline. A machine handles one pending controller operation at a time.

## Device protocol: POST requests only

### 1. Collect or resume a command

```text
POST /api/device/v1/commands/next
Authorization: Bearer <device_token>
Content-Type: application/json

{}
```

Response with no command:

```json
{"job":null,"poll_seconds":15,"machine":{"id":7,"serial":"CNC-7","ip_address":"192.168.1.7","program_path":"//CNC_MEM/USER/PATH1/"}}
```

A SEND command contains `id`, `action:"SEND"`, `program_name`, `program_path`, `ip_address`, `overwrite`, `expires_at`, and `file:{size,sha256,method:"POST",url:"/api/device/v1/jobs/42/file"}`. A BACKUP command contains `action:"BACKUP"`, `source:"CURRENT_RUNNING"`, and no initial filename.

Repeated collection returns the same claimed command until completion. Persist the command ID and phase locally; a repeated response must not perform another controller write. The connection settings in a command are snapshots. Stop acting when its deadline has passed. Poll at the returned interval when idle, with bounded backoff on network errors.

### 2. SEND: download, safely write, verify, acknowledge

```text
POST /api/device/v1/jobs/42/file
Authorization: Bearer <device_token>
```

The response is program bytes. Verify byte length and SHA-256 against the command and `X-Sha256` header. Reject a changed or partial download.

If the destination exists and `overwrite=false`, report `FILE_EXISTS`. An explicitly authorized replacement must first read and save the old controller bytes:

```text
POST /api/device/v1/files
Authorization: Bearer <device_token>
Body: multipart/form-data
  file=<old controller bytes>
  type=BACKUP
  job_id=42
  program_name=O1001.nc
  sha256=<old file SHA-256>
```

This upload is idempotent for that command and exact payload. Confirm the saved backup checksum before replacing anything. Recheck that the original program has not changed since the backup. Refuse writes to a running/incompatible controller. Write and read back the destination, then:

```text
POST /api/device/v1/jobs/42/result
Authorization: Bearer <device_token>
Content-Type: application/json

{"status":"DONE","verified":true,"replaced":false,"sha256":"<verified new file SHA-256>"}
```

Use `replaced:true` when an existing program was replaced. The server requires explicit overwrite authorization and a saved previous-program backup in that case. A DONE result without verified checksum/read-back attestation is refused.

### 3. BACKUP: read the actual current CNC program and upload

Resolve the current selected/running program from the controller at command execution. Read a consistent snapshot; report `NO_ACTIVE_PROGRAM`, `UNSUPPORTED_OPERATION`, or `PROGRAM_CHANGED` if it cannot be obtained safely.

```text
POST /api/device/v1/backup
Authorization: Bearer <device_token>
Body: multipart/form-data
  file=<actual current controller program bytes>
  job_id=43
  program_name=O2002.nc
  sha256=<actual file SHA-256>
```

`201 {"file":{"id":...,"kind":"BACKUP",...}}` means the server saved the bytes and completed the command together. Retrying the same command with the same name/checksum returns the same file ID. Another Backup click creates another command and another saved version. A backup never changes the uploaded reference or writes to the CNC.

### 4. Report a device failure

```text
POST /api/device/v1/jobs/43/result
Authorization: Bearer <device_token>
Content-Type: application/json

{"status":"FAILED","error_code":"PATH_NOT_FOUND","message":"The configured program folder does not exist on this controller."}
```

The screen shows this code/message. Useful codes include `PATH_NOT_FOUND`, `PATH_UNSUPPORTED`, `UNSUPPORTED_OPERATION`, `CONTROLLER_UNREACHABLE`, `CONTROLLER_BUSY`, `NO_ACTIVE_PROGRAM`, `PROGRAM_CHANGED`, `WRITE_FAILED`, `READ_FAILED`, and `COMMAND_INTERRUPTED`.

A server can validate path syntax, not its existence on the factory LAN. The adapter must report actual controller errors. On 401/403, stop and resolve token/company/machine access. On HTTP 429, respect backoff. On a lost result reply, retry the result without rewriting the program. An interrupted/uncertain write needs read-back reconciliation or explicit failure; never blindly execute it again.

## MQTT and costs

Existing telemetry can continue over its current MQTT connection. A device that only publishes telemetry needs updated software to receive commands. This implementation supports POST polling without another broker or worker.

The same MQTT client could subscribe to a private command notification topic after broker ACLs and device support are configured, then collect the durable command through the POST API. Send small notifications over MQTT and file bytes over HTTPS; a notification does not prove delivery or CNC completion. The database command and verified device result remain authoritative.

Legacy file/publication and SEND/FETCH APIs remain for existing integrations. The new operator screen uses the acknowledged command flow above. No Postman collection or environment files are shipped.

## Server file storage

New files use `STORAGE_ROOT/company-<company_id>/programs/machine-<machine_id>/uploads`, `backups` or `fetched`. Machine IDs keep paths stable when controller IPs change. Images use `STORAGE_ROOT/company-<company_id>/images/machines`. Historical program records continue reading their previous `PROGRAM_TRANSFER_DIR` (default `Backend/storage/ProgramTransfer`); retain that directory. These are private server locations, unrelated to the CNC's configured program path. Device APIs and MQTT telemetry are unchanged. Back up the database and matching file roots together. Server deployment and image migration instructions are maintained in the backend repository at `docs/LOCAL_FILE_STORAGE.md`.
