# Program Transfer — gateway API

Four HTTPS calls between the gateway at a machine (a Node-RED PC, a laptop,
any program) and the MEXA server:

| Call | What it does |
| --- | --- |
| `GET  /api/device/v1/status`  | Ask: is there a new program? Has someone asked for a backup? |
| `GET  /api/device/v1/program` | Download the machine's program |
| `POST /api/device/v1/backup`  | Upload a backup file from the machine |
| `POST /api/device/v1/report`  | Say what happened: program written, machine refused it, backup could not be read |

That is all. How the gateway talks to the CNC (FTP, FOCAS, a shared folder,
anything) is up to the gateway; the server never connects to a machine.

**Postman:** `docs/postman/MEXA_Program_Transfer.postman_collection.json`
has every call with example answers and errors. Import it, set `baseUrl`
and `token`, and run the folder *Gateway — the 4 calls* top to bottom.

## The gateway's loop

```
every 15 s:  GET /status
  program.status == WAITING and its sha256 is new
      → GET /program → write it to the CNC
      → POST /report {file_id, status: DONE}
        or POST /report {file_id, status: FAILED, message: "why"}
  backup_request is not null
      → read the program from the CNC
      → POST /backup (the file)
        or POST /report {backup_request_id, status: FAILED, message: "why"}
```

## A ready-made gateway

`mexa-gateway.js` does the loop above with a folder as the machine — a new
program is written into `PROGRAM_DIR` (the folder the CNC reads: its network
share, a DNC folder); **Backup now** sends the newest file in it. Node.js 20,
nothing to install. Download it from **Program Transfer → Gateway token →
Ready-made gateway** (or Backend `tools/gateway/`).

```bash
MEXA_URL=https://SERVER MEXA_TOKEN=mxd_... PROGRAM_DIR=/path/to/machine/folder node mexa-gateway.js
```

```powershell
$env:MEXA_URL="https://SERVER"; $env:MEXA_TOKEN="mxd_..."; $env:PROGRAM_DIR="C:\CNC\VMC-1"; node mexa-gateway.js
```

To try the whole flow on a laptop: make the token, start the gateway with
any folder, upload an `.nc` file on the page — within 15 s it is in the
folder and the page shows **On the machine since …**. For a controller
reached another way (FTP, FOCAS), replace the two functions marked MACHINE
in the file: `writeToMachine` and `readFromMachine`.

## The token

Each machine has its own token. In MEXA: **Program Transfer → choose the
machine → Gateway token → Create token**. It looks like `mxd_` followed by 43
characters and is shown once; keep it in the gateway's settings for that
machine. A gateway serving five machines keeps five tokens.

Send it on every call:

```http
Authorization: Bearer mxd_...
```

The token says which machine the call is about, so a call never names a
machine and cannot reach another one. **Replace token** stops the old one at
once; **Revoke** stops it with no replacement.

Use HTTPS and keep certificate checks on.

## 1. GET /status — call it every `poll_seconds` (15 s)

```bash
curl -H "Authorization: Bearer $TOKEN" https://SERVER/api/device/v1/status
```

```json
{
  "machine": { "id": 15, "serial": "VMC-15" },
  "program": {
    "file_id": 42,
    "program_name": "O1001.nc",
    "size_bytes": 1472,
    "sha256": "9f2c…64 hex characters…",
    "uploaded_at": "2026-10-21T08:00:00.000Z",
    "status": "WAITING",
    "message": null
  },
  "backup_request": { "id": 9, "requested_at": "2026-10-21T08:05:00.000Z" },
  "poll_seconds": 15
}
```

- `program` is the machine's program: the newest file someone uploaded for
  it. `null` until the first upload. When its `sha256` differs from the one
  you last wrote to the CNC and `status` is `WAITING`, download it (call 2).
  `DONE` / `FAILED` mean you already reported this file (call 4): do not try
  it again. A corrected upload comes with a new `file_id` and `sha256`.
- `backup_request` is not `null` when someone pressed **Backup** on the page.
  Read the program from the CNC and upload it (call 3). A request nobody
  answers within 30 minutes lapses.

## 2. GET /program — download the program

```bash
curl -H "Authorization: Bearer $TOKEN" -o program.nc https://SERVER/api/device/v1/program
```

The body is the file itself. The headers say what it is:

| Header | Example |
| --- | --- |
| `X-Program-Name` | `O1001.nc` (URL-encoded) |
| `X-File-Id` | `42` |
| `X-Sha256` | the file's SHA-256 — check it before writing to the CNC |
| `Content-Length` | `1472` |

`404` with code `NO_PROGRAM` means nothing has been uploaded for this machine.
The same program can be downloaded as often as needed. After writing it to
the CNC, report the result (call 4).

## 3. POST /backup — upload a backup

Multipart form data:

| Field | |
| --- | --- |
| `file` | the program file read from the CNC (required) |
| `program_name` | its name on the CNC, e.g. `O1001.nc` (optional; else the file's name) |

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -F "program_name=O1001.nc" -F "file=@O1001.nc" \
     https://SERVER/api/device/v1/backup
```

```json
{
  "file": { "file_id": 43, "program_name": "O1001.nc", "size_bytes": 1472,
            "sha256": "…", "uploaded_at": "2026-10-21T08:06:10.000Z" },
  "answered_request": 9
}
```

The backup is saved on the server and listed on the Program Transfer page.
It answers an open backup request (the person who asked is notified). A
backup can also be sent without a request — after a change on the machine,
or every night. If the CNC cannot be read, report it instead (call 4).

## 4. POST /report — say what happened

JSON. One of three:

```json
{ "file_id": 42, "status": "DONE" }
{ "file_id": 42, "status": "FAILED", "message": "CNC memory full" }
{ "backup_request_id": 9, "status": "FAILED", "message": "CNC not reachable" }
```

| Report | What the page shows | Who is notified |
| --- | --- | --- |
| program `DONE` | ✅ On the machine since 10:42 | the person who uploaded it |
| program `FAILED` | ❌ The machine could not use it: *message* | the person who uploaded it |
| backup `FAILED` | ❌ Backup failed: *message*, and Backup now works again | the person who asked |

- `message` is required with `FAILED` (up to 500 characters) — write it for
  the person at the page: "Program O1001 is running", "CNC memory full".
- `file_id` is the program from `/status` or the `X-File-Id` header.
- A backup that worked needs no report: uploading it (call 3) answers the
  request, so `status: DONE` with `backup_request_id` is refused — and so is
  a report with the backup's own `file_id` (`BACKUP_NEEDS_NO_REPORT`). Report a
  `file_id` only for the program from `/status` (or the `X-File-Id` header).
- The same report sent again (a retry after a lost answer) changes nothing
  and notifies no one twice: `{"file_id": 42, "status": "DONE", "unchanged": true}`.

```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"file_id": 42, "status": "FAILED", "message": "CNC memory full"}' \
     https://SERVER/api/device/v1/report
```

## Files

Text NC programs up to 20 MB (`PROGRAM_MAX_MB` on the server). Names: no
path, at most 100 characters, extension one of `.nc .prg .cnc .txt .tap .eia
.min .gcode .ptp .mpf .spf` or none (`O1234`).

## Errors

Every error is JSON: `{"status":"error","code":"…","message":"…"}`.

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `TOKEN_MISSING` / `TOKEN_INVALID` | No token, a wrong one, or a revoked one |
| 403 | `MACHINE_INACTIVE` / `COMPANY_DISABLED` | The machine or company is switched off in MEXA |
| 404 | `NO_PROGRAM` | No program uploaded for this machine yet |
| 404 | `FILE_NOT_FOUND` / `REQUEST_NOT_FOUND` | Report about a file or request that is not this machine's |
| 400 | `BAD_STATUS` / `NO_MESSAGE` / `NOTHING_TO_REPORT` | Report: status must be DONE or FAILED; FAILED needs a message; send file_id or backup_request_id |
| 400 | `BACKUP_NEEDS_NO_REPORT` | Report: that file_id is a backup the gateway sent — a backup needs no report (the 201 from POST /backup finished it) |
| 400 | `NO_FILE` / `BAD_UPLOAD` | Send the file as multipart field `file` |
| 400 | `BAD_NAME` / `BAD_TYPE` / `NOT_TEXT` / `EMPTY` | Not a usable program name or text file |
| 413 | `TOO_LARGE` | Over the size limit |
| 429 | | Too many calls (or too many wrong tokens) — wait and try again |
| 5xx | `SERVER_ERROR` | Try again later |

Retry a failed call after a pause; back off when the server keeps failing.
