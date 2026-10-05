# STM MEXA Program Transfer — Device API

**For the embedded team.** This is the API the device at each machine calls.
It covers how the device:

- receives new programs from the platform,
- sends backups of the machine's programs, and
- sends a program when a user asks for one.

The device software (Python or anything else) is yours. This page is only the
contract between the device and the platform.

---

## 1. The setup, once per machine

1. A platform admin opens **Program Transfer** and chooses the machine, then
   sets its **Program path**. This is the folder on the machine where
   programs live, for example `//CNC_MEM/USER/PATH1/`.
2. The admin clicks **Link a device → Create token**. The platform shows two
   values, once only:
   ```
   MEXA_URL=https://stmapi.stmcnc.com
   MEXA_DEVICE_TOKEN=mxd_…            (47 characters)
   ```
3. The device keeps them in a file only its administrator can read. Never put
   them in code, in git, or in a log.
4. The device calls `GET /ping`. The platform then shows the device as
   **Online**.

There is one token per machine. When an admin replaces or revokes it, the old
token stops working at once.

## 2. Connection rules

| | |
|---|---|
| Base URL | `{MEXA_URL}/api/device/v1` |
| Every request | header `Authorization: Bearer {MEXA_DEVICE_TOKEN}` |
| Optional header | `X-Agent-Version: 1.0.0` (shown on the platform) |
| Transport | HTTPS only. The device always starts the call; nothing on the factory side is opened |
| Answers | JSON, except the program download (bytes) |
| Errors | `{ "status": "error", "code": "JOB_NOT_OPEN", "message": "…" }` — act on `code`, log `message` |
| Polling | every `poll_seconds` from `/ping` (15 s) |

## 3. The workflows

The platform keeps a queue of **jobs** for each machine. The device asks for
the next job, does it, and says how it went.

| Job `action` | Meaning | Direction |
|---|---|---|
| `SEND` | A user uploaded a **new program** for this machine | platform → machine |
| `FETCH` | A user asked for a **program that is on the machine** | machine → platform |

Backups need no job. The device uploads them itself: before an overwrite, and
on its own schedule.

### Workflow A — new program (platform → machine)

```
GET  /jobs/next                         → 200 job { action: "SEND", target_file, overwrite, file.sha256 }
GET  /jobs/{id}/file                    → the program's bytes; check size and SHA-256
     is target_file already on the machine?
       no                               → save the new program at target_file
       yes, overwrite = false           → POST /jobs/{id}/result  FAILED "already on the machine"   (stop)
       yes, overwrite = true            → read it, then
                                          POST /files  type=BACKUP job_id={id}   → must answer 201
                                          then save the new program at target_file
     read target_file back; it must equal what was downloaded
POST /jobs/{id}/result  {"status":"DONE"}          (or FAILED with a message)
```

### Workflow B — backup (machine → platform)

**Before an overwrite.** This is part of Workflow A. Send `job_id` = the SEND
job's id.

**On the device's own schedule.** For example nightly, or when a program on
the machine changes. Upload each program from the program path, with no
`job_id`:

```
POST /files   type=BACKUP   program_name=O1234.nc   file=<bytes>   sha256=<hex>   → 201
```

### Workflow C — a user asks for a program (machine → platform)

```
GET  /jobs/next                         → 200 job { action: "FETCH", program_name, target_file }
     read target_file from the machine
       not there                        → POST /jobs/{id}/result  FAILED "O2001.nc is not on the machine."
       found                            → POST /files  type=FETCHED  job_id={id}  file=<bytes>   → 201
                                          (this completes the job: no result call needed)
```

### Workflow D — what is on the machine

Every ~5 minutes, and after every job, send the list of programs in the
program path. The platform shows it as "On the machine" and uses it to warn
before an overwrite.

```
PUT /controller-files   {"files":[{"name":"O1234.nc","size":2048,"modified":"2026-10-05T04:00:00Z"}]}
```

### The device's loop

```
on start:            GET /ping   → learn program_path, poll_seconds
                     if a job was interrupted last time (device restarted mid-job):
                        POST /jobs/{that id}/result FAILED "device restarted during this job"   (never redo it)
every poll_seconds:  GET /jobs/next
                        204 → nothing; wait
                        200 → do the job (Workflow A or C), then ask again at once
every ~5 minutes:    GET /ping (the program path can be changed by an admin)
                     PUT /controller-files
on 401 / 403:        stop and alert: the token was revoked or the machine switched off
on network errors:   retry, waiting longer each time (up to 5 minutes)
```

## 4. Endpoints

### `GET /ping`

Checks the token. It is also the heartbeat.

```json
200 {
  "device_id": 3,
  "machine": { "serial": "VMC-1", "ip_address": "192.168.200.3", "program_path": "//CNC_MEM/USER/PATH1/" },
  "server_time": "2026-10-05T18:19:11.119Z",
  "poll_seconds": 15
}
```

`program_path` is `null` until an admin sets it. While it is `null` there will
be no jobs.

### `GET /jobs/next`

Gives the oldest waiting job for this machine and marks it as taken by this
device. No other call can take it again. **204** (no body) means there is
nothing to do.

```json
200 { "job": {
  "id": 11,
  "action": "SEND",
  "program_name": "O1234.nc",
  "program_path": "//CNC_MEM/USER/PATH1/",
  "target_file": "//CNC_MEM/USER/PATH1/O1234.nc",
  "overwrite": true,
  "requested_at": "2026-10-05T18:20:02.000Z",
  "requested_by": "Priya",
  "file": { "size": 2048, "sha256": "9f2c…", "url": "/api/device/v1/jobs/11/file" }
} }
```

- `target_file` is `program_name` inside `program_path`. Save to it (SEND) or
  read from it (FETCH).
- `program_path` is the path when the job was made. It does not change if an
  admin edits the machine's path later.
- `file` is `null` for FETCH jobs.

### `GET /jobs/{id}/file`

The program of a SEND job this device has taken, as
`application/octet-stream`. Headers:

| Header | |
|---|---|
| `X-Sha256` | hex SHA-256 of the bytes; check it before using the file |
| `Content-Length` | size in bytes |
| `X-Program-Name` | URL-encoded program name |

### `POST /files` — every program going from the machine to the platform

Send `multipart/form-data` with these fields:

| Field | Required | |
|---|---|---|
| `file` | yes | the program's bytes |
| `type` | yes | `BACKUP` (a copy of what is on the machine) or `FETCHED` (the answer to a FETCH job) |
| `job_id` | FETCHED: yes. BACKUP: before an overwrite | the job it belongs to |
| `program_name` | no | its name on the machine. Defaults to the job's name, or the file's name |
| `sha256` | recommended | hex SHA-256 of `file`; the platform refuses the upload if it differs |
| `note` | no | up to 255 characters, shown to users |

```json
201 { "file": { "id": 41, "kind": "BACKUP", "program_name": "O1234.nc", "size": 1990, "sha256": "…", "created_at": "…" } }
```

### `POST /jobs/{id}/result`

```json
{ "status": "DONE" }
{ "status": "FAILED", "message": "Controller memory is full." }
```

- `message` is required for FAILED. The person who asked reads it, so write
  it for them.
- Sending the same result again is accepted, which makes retries safe.

### `PUT /controller-files`

```json
{ "files": [ { "name": "O1234.nc", "size": 2048, "modified": "2026-10-05T04:00:00Z", "comment": "FLANGE" } ] }
```

- At most 5000 entries per call.
- `size`, `modified` and `comment` may be `null`.
- Each call replaces the previous list.

## 5. Error codes

| HTTP | `code` | Meaning — what the device does |
|---|---|---|
| 401 | `TOKEN_MISSING`, `TOKEN_INVALID` | No token, or it was replaced or revoked — stop, alert |
| 403 | `MACHINE_INACTIVE`, `COMPANY_DISABLED` | The machine or company is switched off — stop, alert |
| 404 | `JOB_NOT_FOUND` | Not a job for this machine — drop it |
| 409 | `JOB_NOT_OPEN` | Already finished, cancelled or timed out — drop it |
| 409 | `WRONG_ACTION` | A file was asked for on a FETCH job — fix the device logic |
| 409 | `NO_FILE` | DONE was reported for a FETCH job before its file was uploaded |
| 410 | `FILE_GONE` | The program was deleted on the platform — report FAILED |
| 400 | `BAD_TYPE`, `BAD_JOB`, `NO_FILE`, `BAD_NAME`, `NOT_TEXT`, `EMPTY`, `NO_MESSAGE`, `BAD_STATUS`, `BAD_LIST` | The request is wrong — fix and do not retry as is |
| 413 | `TOO_LARGE` | Over the size limit (20 MB) |
| 422 | `CHECKSUM_MISMATCH` | The upload arrived changed — send it again |
| 429 | `TOO_MANY_REQUESTS`, `TOO_MANY_FAILURES` | Too many calls — wait, then poll at `poll_seconds` |
| 5xx | `SERVER_ERROR` | Retry later |

## 6. Rules the device must keep

1. **HTTPS only.** Keep the token in a protected file and never log it.
2. **Check every download.** Its size and SHA-256 must match before anything
   is written to the machine.
3. **Back up before overwriting.** Upload the program already on the machine
   (`type=BACKUP`, with the job id). Write the new one only after that upload
   answered 201.
4. **Write only to `target_file`.** Never execute or start a program; the
   operator still selects it and presses CYCLE START.
5. **Never redo an interrupted job.** Remember the job id on disk while
   working. After a restart, report that job FAILED.
6. **Answer every job you took.** A job taken but not answered within
   **15 minutes** is marked FAILED by the platform. A job no device takes
   within **24 hours** also fails.
7. **On 401/403, stop.** Do not retry in a loop.

Limits:

- A program is a text file of at most 20 MB.
- A program name is at most 100 characters, without folder separators.
- About 600 calls per 15 minutes per device.

## 7. Trying it with curl

```bash
URL=https://stmapi.stmcnc.com/api/device/v1
AUTH="Authorization: Bearer mxd_…"

curl -s -H "$AUTH" $URL/ping
curl -s -w '\nHTTP %{http_code}\n' -H "$AUTH" $URL/jobs/next
curl -s -H "$AUTH" -o O1234.nc $URL/jobs/11/file && sha256sum O1234.nc
curl -s -H "$AUTH" -F type=BACKUP -F job_id=11 -F program_name=O1234.nc -F file=@O1234-on-machine.nc $URL/files
curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"status":"DONE"}' $URL/jobs/11/result
curl -s -H "$AUTH" -F type=FETCHED -F job_id=12 -F file=@O2001.nc $URL/files
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' -d '{"files":[{"name":"O1234.nc","size":2048}]}' $URL/controller-files
```
