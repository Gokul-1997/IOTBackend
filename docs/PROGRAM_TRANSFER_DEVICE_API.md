# Program Transfer — Device API

**For the device team.** How the small device at each machine (the one that
already posts telemetry over MQTT) sends programs to the CNC and sends
programs from the CNC back to the server.

Reference agent, standard-library Python 3.8+: `tools/program-agent/program_agent.py`.
It runs this whole protocol. The only part you write is the class that talks
to the controller (FOCAS or the controller's FTP on the machine LAN).

---

## 1. How it works

The device always starts the conversation. It calls the server over HTTPS.
The server never connects into the factory, so no port is opened on the
factory side.

```
 Web user                       Server (ProgramTransfer folder)            Device at the machine          CNC
 ────────                       ───────────────────────────────            ─────────────────────          ───
 Upload O1234.nc, "send"  ───▶  saves …_NEW_O1234.nc, job #11 QUEUED
                                                                 ◀───  GET /jobs/next   (every 15 s)
                                job #11 DELIVERED  ─────────────────▶  { SEND O1234.nc, sha256, url }
                                                                 ◀───  GET /jobs/11/file
                                                                       O1234.nc already on the CNC?
                                                                         read it  ─────────────────────▶  (old program)
                                saves …_BACKUP_O1234.nc          ◀───  POST /files  type=BACKUP job_id=11
                                                                         write the new one ────────────▶  O1234.nc
                                job #11 DONE, user notified      ◀───  POST /jobs/11/result  DONE
```

**Fetching from the CNC** works the same way. The user clicks "Get" on a
program in the machine list. The device's next poll gives it a `FETCH` job,
and the device answers with `POST /files type=FETCHED job_id=…`.

**The machine list on the screen** shows what the device reports with
`PUT /controller-files`.

## 2. Getting a token

1. In the web app, go to **Program Transfer**, choose the machine, and click
   **Link a device** (or **Device token**). This needs the *Machines → Edit*
   permission.
2. Click **Create token**. The configuration appears **once**:
   ```
   MEXA_URL=https://stmapi.stmcnc.com
   MEXA_DEVICE_TOKEN=mxd_3f9a…(47 characters)
   ```
3. Put it in the device's configuration file, for example
   `/etc/mexa/program-agent.env`, owned by root and set to `chmod 600`. Never
   put it in code, in git, or in a log.
4. Start the agent. Within seconds the screen shows **Online · checked in
   … ago**.

Each machine has **one live token**:
- **New token** replaces the old one. The old token stops working at once.
- **Revoke** stops the device immediately, for example when it is lost or
  swapped.

The token is tied to its machine. A device can only see and change its own
machine's jobs and files.

For an on-premise server, `MEXA_URL` is the customer's own server address. If
that server uses its own certificate, give the device that CA in
`MEXA_CA_FILE`.

## 3. Security rules

| Rule | Why |
|---|---|
| **HTTPS only.** Never `http://` outside a test bench | The token is sent on every call |
| Send the token as `Authorization: Bearer mxd_…` | The API accepts nothing else, and a user's sign-in token is refused here |
| Keep the token in a root-only file (`chmod 600`) | Anyone holding it acts as this machine |
| The server stores only a SHA-256 of the token; the token is shown once | A copy of the database cannot be used as a device |
| Check `sha256` and `size` of every downloaded program before writing to the CNC | A damaged download must never reach the controller |
| Send `sha256` with every upload; the server refuses a mismatch (422) | Damaged uploads are caught too |
| Before overwriting, upload the program already on the CNC as `BACKUP`. If that upload fails, do not overwrite | Nothing on the machine is lost |
| Write only to the program memory, using the name from the job. Never execute anything, never start the program | The operator still selects the program and presses CYCLE START |
| Outbound connections only | Nothing in the factory is exposed |
| On `401` / `403`, stop and alert. Do not retry in a loop | The token was revoked or the machine was switched off |

The server also limits calls: about 600 calls per 15 minutes per device, and
60 wrong-token calls per 15 minutes per address. Files must be text (a NUL
byte is refused) and at most 20 MB (`PROGRAM_MAX_MB`). Program names are
reduced to a safe file name of at most 100 characters.

## 4. Endpoints

Base: `{MEXA_URL}/api/device/v1`. Every request sends
`Authorization: Bearer <token>`. It may also send `X-Agent-Version: 1.0.0`,
which is shown on the screen.

Errors always look like this:

```json
{ "status": "error", "code": "JOB_NOT_OPEN", "message": "…" }
```

Branch on `code`. `message` is for the log.

### GET /ping

Checks the token. Each call also counts as a heartbeat.

```json
200 { "device_id": 3, "machine": { "serial": "VMC-1", "ip_address": "192.168.200.3" },
      "server_time": "2026-10-05T18:19:11.119Z", "poll_seconds": 15 }
```

Poll every `poll_seconds`. The interval is set centrally (`DEVICE_POLL_SECONDS`).

### GET /jobs/next

The oldest waiting job for this machine. Taking it marks it **DELIVERED** to
this device, and no other call can take it. **204** means there is nothing to
do.

```json
200 { "job": {
  "id": 11, "action": "SEND", "program_name": "O1234.nc", "overwrite": true,
  "requested_at": "…", "requested_by": "Priya",
  "file": { "size": 2048, "sha256": "9f2c…", "url": "/api/device/v1/jobs/11/file" } } }
```

- `action: "SEND"`: write the file to the CNC as `program_name`.
- `action: "FETCH"`: read `program_name` off the CNC and upload it. In this
  case `file` is `null`.
- `overwrite: false`: if the program is already on the CNC, report
  **FAILED** and do not write. The user is asked to confirm first, and only
  then is the job sent again with `overwrite: true`.

After a job, call `/jobs/next` again straight away. Only when it answers 204,
wait `poll_seconds`.

### GET /jobs/{id}/file

The program of a SEND job you have taken, as `application/octet-stream`.
Headers:

- `X-Sha256`
- `Content-Length`
- `X-Program-Name` (URL-encoded)

Codes:

| Code | When |
|---|---|
| 404 `JOB_NOT_FOUND` | Not this machine's job |
| 409 `JOB_NOT_OPEN` | Not taken, or already finished |
| 409 `WRONG_ACTION` | A FETCH job |
| 410 `FILE_GONE` | Deleted on the server |

### POST /files — one upload, tagged

Send `multipart/form-data` with these fields:

| Field | |
|---|---|
| `file` | the program bytes (required) |
| `type` | `BACKUP` (what is on the CNC) or `FETCHED` (a program a user asked for) |
| `job_id` | `FETCHED`: required, the FETCH job. `BACKUP`: the SEND job it was taken for, or nothing for your own scheduled backups |
| `program_name` | its name on the CNC. Defaults to the job's name, or the file name |
| `sha256` | hex SHA-256 of the bytes (recommended; checked) |
| `note` | optional, up to 255 characters, shown on the screen |

```json
201 { "file": { "id": 41, "kind": "BACKUP", "program_name": "O1234.nc",
                "stored_as": "company-5/192.168.200.3/20261005-103020_BACKUP_O1234.nc",
                "size": 1990, "sha256": "…", "created_at": "…" } }
```

An upload tagged `FETCHED` **completes** its FETCH job (DONE). No result call
is needed for it.

Errors:

| Code | When |
|---|---|
| 400 `BAD_TYPE` | `type` is missing or not one of the two tags |
| 400 `BAD_JOB` | `FETCHED` without a `job_id` |
| 422 `CHECKSUM_MISMATCH` | The bytes do not match `sha256` |
| 413 `TOO_LARGE` | Over the size limit |
| 400 `NOT_TEXT` | The file contains a NUL byte |
| 400 `BAD_NAME` | The program name is not usable |

### POST /jobs/{id}/result

```json
{ "status": "DONE" }
{ "status": "FAILED", "message": "O1234.nc is already on the controller." }
```

- `FAILED` needs a `message`. It is shown to the person who asked and sent to
  them as a notification, so write it for that person.
- Sending the same result twice is fine, which makes retries safe. A
  different result for a finished job answers `409 JOB_NOT_OPEN`.

### PUT /controller-files

What is on the CNC now. It replaces the previous list, and feeds the screen's
"On the machine" list and the "already on the machine?" check.

```json
{ "files": [ { "name": "O1234", "size": 2048, "modified": "2026-10-05T04:00:00Z", "comment": "FLANGE" } ] }
```

- At most 5000 entries.
- `size`, `modified` and `comment` may be `null`.
- Send it every few minutes, and after every job.

## 5. Timing and recovery

- **Poll:** every 15 s (`poll_seconds`). On network errors, back off up to 5
  minutes.
- **A job you took but did not report:** the server marks it **FAILED**
  after 15 minutes.
- **A job nobody took:** **FAILED** after 24 hours, for example when the
  device was off.
- **The device restarts or loses the network mid-job:** do **not** redo the
  job. Write the job id to disk before you start. On the next run, report
  that job as **FAILED** ("the device restarted during this job — check the
  controller"). The reference agent does this with `MEXA_STATE_FILE`.

## 6. Trying it

```bash
# check the token
curl -H "Authorization: Bearer $MEXA_DEVICE_TOKEN" $MEXA_URL/api/device/v1/ping

# one poll of the reference agent against a folder standing in for the CNC
CNC_DIR=./cnc python3 tools/program-agent/program_agent.py --config ./agent.env --once

# upload every program on the CNC as a scheduled backup
python3 tools/program-agent/program_agent.py --config ./agent.env --backup-all
```

## 7. On the server

Files are kept on the server's disk in `PROGRAM_TRANSFER_DIR` (default
`Backend/storage/ProgramTransfer`):

```
ProgramTransfer/
  company-5/                       one folder per company: two companies can both have 192.168.1.10
    192.168.200.3/                 one folder per machine IP (machine-<id> when no IP is set)
      20261005-103012_NEW_O1234.nc         uploaded by a user
      20261005-103020_BACKUP_O1234.nc      read off the CNC before the overwrite
      20261005-111502_FETCHED_O2001.nc     read off the CNC because a user asked
```

- Names start with plant time (IST), then the kind, then the program name.
  Nothing in the folder is ever overwritten.
- The database (migration `030_program_transfer_device.sql`) holds the
  machine, kind, checksum, uploader and job of every file, and the full job
  history.
- Back up this folder together with the database.
