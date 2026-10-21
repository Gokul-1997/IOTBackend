# Program Transfer — gateway API

Three HTTPS calls between the gateway at a machine (a Node-RED PC, a laptop,
any program) and the MEXA server:

| Call | What it does |
| --- | --- |
| `GET  /api/device/v1/status`  | Ask: is there a new program? Has someone asked for a backup? |
| `GET  /api/device/v1/program` | Download the machine's program |
| `POST /api/device/v1/backup`  | Upload a backup file from the machine |

That is all. How the gateway talks to the CNC (FTP, FOCAS, a shared folder,
anything) is up to the gateway; the server never connects to a machine.

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
    "uploaded_at": "2026-10-21T08:00:00.000Z"
  },
  "backup_request": { "id": 9, "requested_at": "2026-10-21T08:05:00.000Z" },
  "poll_seconds": 15
}
```

- `program` is the machine's program: the newest file someone uploaded for
  it. `null` until the first upload. When its `sha256` differs from the one
  you last wrote to the CNC, download it (call 2).
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
The same program can be downloaded as often as needed.

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
or every night.

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
| 400 | `NO_FILE` / `BAD_UPLOAD` | Send the file as multipart field `file` |
| 400 | `BAD_NAME` / `BAD_TYPE` / `NOT_TEXT` / `EMPTY` | Not a usable program name or text file |
| 413 | `TOO_LARGE` | Over the size limit |
| 429 | | Too many calls (or too many wrong tokens) — wait and try again |
| 5xx | `SERVER_ERROR` | Try again later |

Retry a failed call after a pause; back off when the server keeps failing.
