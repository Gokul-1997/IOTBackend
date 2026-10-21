# Windows / Node-RED Gateway API — Program Transfer

For the two everyday operations, start with the [simple API guide](GATEWAY_QUICK_START.md).
One company laptop/PC running Node-RED is one gateway. Assign one or many machines
to it. All gateway communication below uses outbound HTTPS; Socket.IO is used only
between the application server and web UI.

## Developer handoff

Give your embedded developer the server HTTPS URL, the private gateway token,
and this API contract. They connect these endpoints to their existing Node-RED
machine integration. All command and file communication uses HTTPS POST.

## Responsibility boundary

The application handles company/plant isolation, gateway assignment, server-side
files, command queues, leases, status, verified captures and audit history.
**The embedded team implements all gateway-to-CNC communication**, including
controller drivers, selected/executing program identification, safe writing,
controller paths, read-back, local buffering and physical-operation recovery.
Existing Node-RED MQTT telemetry can continue unchanged.

A server upload is a reference file. It becomes a successful controller transfer
only after the assigned gateway confirms a safety-validated write and exact
SHA-256 read-back. Current-program backup requires newly read machine-side bytes,
not the last uploaded server copy.

## Commission once

1. Sign in as a company administrator with Program Transfer and machine edit
   access. Open **Program Transfer → Gateway & machine connection**.
2. Register a company or plant gateway. Save the one-time `mxg_...` token privately
   on the Windows/Node-RED host. One gateway can own many machines; a dedicated
   gateway uses exactly the same API with one assignment.
3. Assign each machine its gateway, a local `controller_key`, protocol label and
   program root. Host addresses, protocol passwords and manufacturer SDK details
   stay with the embedded team. A profile key must identify one machine on that
   gateway.
   The simple assignment body can contain only `gateway_id` and `program_path`:
   new assignments default to `protocol:"embedded"` and `controller_key:"machine-<id>"`.
   Existing profile/protocol values are preserved when omitted. Developer settings
   in the UI allow a custom mapping when required by the embedded integration.
4. Call config to get the assigned machine IDs and configuration versions. Report
   only capabilities the embedded integration actually supports. Until reported,
   controller operations stay disabled. Local server uploads remain available.

The `mxg_` gateway credential is different from a user's JWT. Retired per-machine
`mxd_` credentials cannot authenticate this API. Send the gateway token over
trusted HTTPS on every gateway request:

```http
Authorization: Bearer <private-mxg-token>
Content-Type: application/json
X-Agent-Version: node-red-gateway/1.0
```

Gateway API base: `/api/gateway/v1`. Every endpoint below uses **POST**. Do not
send machine passwords, server file paths or gateway tokens in MQTT topics,
URLs, logs or browser requests. Never disable TLS certificate checks. A private
plant CA can be trusted through the host/Node.js CA configuration.

## 1. Get assignments and report actual capabilities

```http
POST /api/gateway/v1/config

{}
```

Example response (IDs are illustrative):

```json
{
  "gateway":{"id":3,"company_id":4,"plant_id":2,"max_concurrency":2},
  "machines":[{"id":15,"serial":"VMC-15","controller_key":"vmc15","protocol":"embedded","program_path":"/PROGRAMS","configuration_version":1}],
  "server_time":"2026-10-20T08:00:00.000Z"
}
```

After validating the local profile, report support using the **same current
configuration_version**. Stale or foreign machine reports cannot change another
assignment:

```json
{"machines":[{"id":15,"configuration_version":1,"capabilities":{"list":true,"upload":true,"download":true,"current_backup":true,"restore":true},"limitations":[],"current_program":"O1001","controller_status":"IDLE"}]}
```

`list` means directory browsing; `upload` means controller writes; `download`
means reading a selected controller file; `current_backup` requires controller
current-program identification plus content retrieval; `restore` means validated
writing of saved backups. Set unsupported values to false and explain them in
`limitations`. Report no more than 200 machine states per request. Refresh config
around every 30 seconds; the response also acts as the gateway heartbeat.

## 2. Collect a durable command

```http
POST /api/gateway/v1/commands/next

{"wait_seconds":24,"available_slots":1,"active_job_ids":[]}
```

The server returns `{ "job": null, "poll_seconds":15 }` when no work is ready.
Long polling waits up to 24 seconds without holding a database connection.
Use an HTTP timeout above 30 seconds. Keep one collection loop per gateway and
respect its configured capacity. `active_job_ids` contains jobs **currently
executing in this gateway process**, not commands remembered but no longer
running after a restart.

A SEND/RESTORE example:

```json
{"job":{"id":101,"machine_id":15,"action":"SEND","source":null,"program_name":"O2002.nc","program_path":"/PROGRAMS","relative_path":"","controller_key":"vmc15","protocol":"embedded","configuration_version":1,"overwrite":false,"lease_token":"<64-hex-private-lease>","expires_at":"2026-10-20T08:15:00.000Z","recovery_only":false,"file":{"size":1472,"sha256":"<64-lowercase-hex-sha256>","url":"/api/gateway/v1/jobs/101/file"}},"poll_seconds":15}
```

Actions are `SEND`, `RESTORE`, `BACKUP`, `LIST`, `FETCH`. BACKUP has
`source:"CURRENT_RUNNING"` and no server source file. LIST/FETCH use
`relative_path` below the configured program root; FETCH also has the requested
`program_name`. Do not concatenate unvalidated paths or accept traversal.

Persist the command, lease, received file, controller-operation phase and any
pre-replacement capture before machine-side changes. A reconnect can return the
same delivered job with the same lease. **Never treat redelivery as a fresh
instruction to write again.** `recovery_only:true` means the deadline passed or
the previous physical write outcome is unknown:
read and reconcile the controller; do not start a new write. A gateway token
cannot collect another gateway's jobs, and a single machine has one open command.

## 3. Download the exact SEND/RESTORE source

```http
POST /api/gateway/v1/jobs/101/file

{"lease_token":"<claimed-lease>"}
```

The response is a binary stream with `Content-Length`, `X-Sha256` and
`X-Program-Name`. Stream to private local disk, hash it and compare with the
queued file metadata before touching the CNC. The current default application
limit is 20 MiB (`PROGRAM_MAX_MB` is configurable). Use matching proxy and gateway
limits. File bytes do not travel over MQTT.

The server path/filename is not a CNC location. Use the job's configured root,
relative path and program name through the embedded controller adapter.

## 4. Report progress

```http
POST /api/gateway/v1/jobs/101/progress

{"lease_token":"<claimed-lease>","stage":"WRITING","bytes":768,"total":1472}
```

Use uppercase stages such as `DOWNLOADING`, `VALIDATING`, `READING`, `BACKING_UP`,
`WRITING`, `VERIFYING`. Do not send `DONE`/`FAILED` as progress. Bytes are
monotonic within a stage and can reset when moving to a different stage. Send
at most every two seconds plus meaningful stage changes. Accepted progress
extends the operation deadline by 15 minutes. The web UI consumes socket events;
no browser connection is required for a transfer to finish.

## 5. Finish a SEND/RESTORE with real evidence

The embedded team must validate the controller's safe state immediately before
writing, protect selected/executing programs and verify actual controller content
after writing. The application user's confirmation does not replace these checks.

```http
POST /api/gateway/v1/jobs/101/result

{"lease_token":"<claimed-lease>","status":"DONE","verified":true,"safety_checked":true,"sha256":"<actual-controller-read-back-sha256>","replaced":false}
```

The SHA-256 must equal the queued reference. `verified:true` and
`safety_checked:true` are embedded-team attestations based on actual checks;
never insert them just because an HTTP request succeeded.

If the destination exists, fail with `FILE_EXISTS` unless `overwrite:true` was
explicitly authorized. Before an authorized replacement, upload the actual old
controller file as a `REPLACEMENT` capture (next section), then write and verify.
A DONE report with `replaced:true` is refused without that saved capture.

## 6. Return actual controller bytes: current backup, fetch, replacement

```http
POST /api/gateway/v1/jobs/102/capture
Content-Type: multipart/form-data; boundary=<streaming-client-boundary>
```

| Multipart field | Value |
| --- | --- |
| `lease_token` | This command's private lease |
| `type` | `CURRENT`, `FETCHED` or `REPLACEMENT` |
| `program_name` | Actual machine-side filename |
| `sha256` | SHA-256 of the bytes being uploaded |
| `file` | Actual streamed file content |
| `current_program_verified` | `true` for CURRENT, after controller-supported identification |
| `controller_reported_name` | Exact `program_name` for CURRENT |

- CURRENT answers BACKUP: identify the executing/selected program through a
  supported controller API, read its contents, verify identity did not change
  during the read, then upload. If unavailable, report `CURRENT_PROGRAM_UNKNOWN`
  or `UNSUPPORTED_CAPABILITY`; do not substitute a server file.
- FETCHED answers FETCH and must match the requested program name.
- REPLACEMENT belongs to an authorized SEND/RESTORE with overwrite enabled and
  must match its target program name. Store it before replacing the controller file.

The server streams, text/size/name validates and checksum-verifies the upload.
CURRENT/FETCHED capture success completes that command and returns
`{file:{...},job:{status:"DONE",...}}`. A separate DONE result is unnecessary.
REPLACEMENT capture only saves the old bytes; the write still needs its verified
result. Repeating an identical capture after a lost reply returns the same file.
Each new Backup click creates a new immutable version even if contents match.

## 7. Return a failure honestly

```http
POST /api/gateway/v1/jobs/101/result

{"lease_token":"<claimed-lease>","status":"FAILED","error_code":"PATH_NOT_FOUND","message":"The configured controller program directory does not exist.","write_started":false}
```

Use clear uppercase codes: `CONTROLLER_OFFLINE`, `CONTROLLER_AUTH_FAILED`,
`PATH_NOT_FOUND`, `PATH_NOT_SUPPORTED`, `PROGRAM_NOT_FOUND`, `FILE_EXISTS`,
`RUNNING_PROGRAM`, `MACHINE_NOT_SAFE`, `UNSUPPORTED_CAPABILITY`,
`CURRENT_PROGRAM_UNKNOWN`, `CHECKSUM_MISMATCH`.

If a write may have started and the reply is lost, do not claim it never started.
Report `write_started:true`. The job stays DELIVERED in
`NEEDS_RECONCILIATION`, preventing another writer or misleading retry. Read the
controller and report the observed outcome. A reconciled success includes the
normal exact proof plus `reconciled:true`; a reconciled failure includes
`write_started:true,reconciled:true,verified:true` and a clear explanation. An
expired write also requires reconciliation. Only queued commands can be cancelled
by an operator. Reassignment and token rotation wait for open work to finish.

The server cannot inspect the physical CNC independently; its machine-side proof
comes from the authenticated embedded integration. Do not deploy a flow that
returns canned success, guessed status or a stale program filename.

## 8. Return a machine directory

When directory browsing is supported, a `LIST` job contains the requested
`relative_path`. Read that directory and report its entries through the result API:

```http
POST /api/gateway/v1/jobs/103/result

{"lease_token":"<claimed-lease>","status":"DONE","path":"parts","listing":[{"name":"O2002.nc","is_directory":false,"size":1472,"modified":"2026-10-20T08:00:00.000Z"},{"name":"archive","is_directory":true,"size":null,"modified":null}],"truncated":false,"current_program":"O1001"}
```

`path` must match the command's `relative_path`; use an empty string for the
configured root. Each entry supplies its immediate name, not an absolute path.
Return at most 2,000 entries. Use `null` when a size or modification timestamp is
unknown, and set `truncated:true` if the directory exceeds that limit. The web
page can open a subdirectory or retrieve a selected file through a new `FETCH`
job. Complete FETCH by uploading its actual bytes as a `FETCHED` capture.

## Node-RED integration requirements

Use the embedded team's existing HTTP request and controller nodes. Store the
gateway token privately, refresh assignments, collect commands, route each command
by `machine_id`, and return the real result. Stream large downloads and multipart
uploads within the configured file limit. Use an HTTP timeout above the long-poll
duration and bounded backoff on errors. Keep TLS certificate verification enabled
and refuse redirects that could forward the gateway credential elsewhere.

Keep command IDs, leases, file checksums and physical-operation state on persistent
local storage. If a result reply is lost, resend the same result or capture;
do not repeat the controller write. On gateway restart, reconcile delivered
commands before starting additional writes. Protect the Windows service account,
Node-RED editor and local program storage with appropriate access permissions.

## Operator API and deployment

The web app uses `/api/programs/v3`, user JWTs and current company/plant/RBAC.
Machine actions use `/machines/:id/uploads`, `/machines/:id/send`,
`/machines/:id/backup`, `/machines/:id/browse`, `/machines/:id/fetch` and
`/machines/:id/restore`. Mutating command requests require
an Idempotency-Key; SEND/RESTORE require explicit `confirm:true`.
The previous unversioned `/api/programs` and per-machine `/api/device/v1` routes
have been removed. Use the operator and gateway APIs above; old device tokens,
polling and file-result requests are no longer supported.

Apply reviewed migration **049_gateway_transfer.sql** and its prerequisites if
not already applied, then deploy API and frontend. Retiring the old routes
requires no additional migration. Rollback refuses to discard saved gateway work or
audit history. No production migration, controller operation or deployment is
performed by the source changes. The embedded team's integration and live hardware
acceptance remain required.

Queued commands expire after 24 hours. Delivered read commands expire after
their 15-minute lease without a successful capture/result. Delivered SEND or
RESTORE commands retain machine ownership after expiry and require verified
controller reconciliation; a timeout never automatically repeats a write.
Authenticated gateways have independent per-process rate limits, so successful
polling behind one plant address does not exhaust browser allowances. Failed
credentials have a separate per-address limit.

## Retiring the previous device flow

Before deploying this release over an older device integration, review its open
jobs using a read-only database administration session:

```sql
SELECT id, machine_id, protocol_version, status
FROM program_jobs
WHERE protocol_version < 3 AND status IN ('QUEUED', 'DELIVERED')
ORDER BY machine_id, id;
```

Pause new legacy requests and resolve existing work through the previous
integration before cutover. Stop the old client before activating its gateway
replacement. A DELIVERED write requires checking the actual controller outcome;
do not automatically cancel it, repeat it, or delete its history. If the outcome
is uncertain, keep that machine blocked until the embedded team reconciles it.

The new gateway assignment and command APIs deliberately refuse machines with
any open job, including old protocol jobs. The retired flow's timeout worker no
longer processes those jobs. Deploying this code does not finish, migrate or
cancel them. Review any remaining work before deployment rather than clearing
its database status just to enable transfers.

Migration history, existing schema, saved program versions and audit/job history
are retained. New files use the company/machine folders under `STORAGE_ROOT`.
Historical files can still refer to the original `PROGRAM_TRANSFER_DIR`; retain
that directory and its configuration and back up both roots with the database.
Removing old API code is not a data or file deletion operation.

## Server file table query

`GET /api/programs/v3/files` uses the operator JWT and machine access scope.
Pass `machine_id`, optional `kind` (`NEW`, `BACKUP`, `FETCHED`), literal `search`,
`page` and `limit`. Sorting accepts `sort=name|size|date` and
`direction=asc|desc`, defaulting to saved date descending. Results are sorted
before pagination, with file ID as the stable tie-breaker. This endpoint lists
saved server versions; machine listings are requested through `LIST` jobs.
