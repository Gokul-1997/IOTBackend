# Program Transfer — gateway API

Four HTTPS calls between the company's gateway (a Node-RED PC, a laptop,
any program on the factory network) and the MEXA server. **One token for
all the company's machines, and one status call for all of them.**

| Call | What it does |
| --- | --- |
| `GET  /api/device/v1/status` | Every machine at once: its `machine_id`, name, controller and controller type (Fanuc / Mitsubishi), `api_key` and program path; is a program waiting for it? Did someone ask for a backup? |
| `GET  /api/device/v1/program?machine_id=ID` | Download the program waiting for that machine |
| `POST /api/device/v1/backup` | Upload a backup file from a machine (form fields `machine_id`, `file`) |
| `POST /api/device/v1/report` | Say what happened: program written, machine refused it, backup could not be read |

That is all. How the gateway talks to a CNC (FTP, FOCAS, a shared folder,
anything) is up to the gateway; the server never connects to a machine.

**Postman:** `docs/postman/MEXA_Program_Transfer.postman_collection.json`
has every call with example answers and errors. Import it, set `baseUrl`,
`token` and `machineId`, and run the folder *Gateway — the 4 calls* top to
bottom.

## The gateway's loop

```
every 15 s:  GET /status                                ← ONE call for every machine
  for each machine in machines:
    program is not null
      → GET /program?machine_id=ID  → write it to the CNC (machine_ip, program_path)
      → POST /report {file_id, status: DONE}
        or POST /report {file_id, status: FAILED, message: "why"}
        the answer's next_program: the next one for this machine (or null)
    backup_request is not null
      → read the program from the CNC (program_path)
      → POST /backup (machine_id, file)
        or POST /report {backup_request_id, status: FAILED, message: "why"}
```

Twenty machines cost one call every 15 seconds, not twenty. Programs and
backups add calls only when there is something to move.

## Programs wait in line, per machine

Two programs uploaded for the same machine are sent **one after the other**,
oldest first. `/status` shows the one in front (`program`) and how many wait
(`programs_waiting`). When you report it — `DONE` or `FAILED` — the next one
takes its place, and the report's answer already names it (`next_program`),
so it can follow at once. A program you do not report stays in front: if the
CNC cannot be reached now, do not report anything; it is offered again on
the next `/status`.

Once you download a program, the page shows it as **sent to the gateway**
(with the time) until you report it. Ten minutes without a report and the
page flags it — the programs behind it are waiting — so always end with
call 4.

Different machines do not wait for each other.

## A ready-made gateway

`mexa-gateway.js` does the loop above for all the company's machines, with a
folder as each machine: a new program for `VMC-01` is written into
`PROGRAM_DIR/VMC-01/` (or the folder `MACHINE_DIRS` gives for it — the CNC's
network share, a DNC folder); **Backup now** sends the newest file in it.
Node.js 20, nothing to install. S&T hands it out with the token (Company
Management → Gateway → Ready-made gateway), or Backend `tools/gateway/`.

```bash
MEXA_URL=https://SERVER MEXA_TOKEN=mxg_... PROGRAM_DIR=/path/to/machines node mexa-gateway.js
```

```powershell
$env:MEXA_URL="https://SERVER"; $env:MEXA_TOKEN="mxg_..."; $env:PROGRAM_DIR="C:\CNC"; node mexa-gateway.js
```

Only some machines on this PC: `MACHINE_DIRS='{"VMC-01":"\\\\cnc01\\programs","VMC-02":"D:\\DNC\\VMC-02"}'`
— then only those are served here, and another gateway can serve the rest.
For a controller reached another way (FTP, FOCAS), replace the two functions
marked MACHINE in the file, `writeToMachine` and `readFromMachine`; they are
given the machine as `/status` lists it — its `machine_id`, name, IP,
controller and `program_path`. The folder version itself writes only into
`PROGRAM_DIR` or `MACHINE_DIRS`, never into a `program_path`.

## The token

One token per company, for all its machines. **S&T makes it** (S&T Super
Admin → Company Management → the company → **Gateway** → Make token) and
gives it to the gateway team. It looks like `mxg_` followed by 43 characters
and is shown once.

Send it on every call:

```http
Authorization: Bearer mxg_...
```

The token says which company the call is about; a call can only ever reach
that company's machines. **Replace token** stops the old one at once; **Stop
token** stops it with no replacement. Machine tokens from before 22 Oct 2026
(`mxd_…`) no longer work (`TOKEN_REPLACED`).

Use HTTPS and keep certificate checks on.

## Naming a machine

A call about one machine names it with **`machine_id`** — the number
`/status` lists for it. It never changes, whatever the machine is renamed to.

Gateways built before 23 Oct 2026 may still send the machine's name
(`machine`, as `/status` lists it, any case) or its IP (`machine_ip`); that
keeps working. Sent together with `machine_id`, a name or IP must be that
machine's (`400 MACHINE_MISMATCH` otherwise).

## 1. GET /status — call it every `poll_seconds` (15 s)

```bash
curl -H "Authorization: Bearer $TOKEN" https://SERVER/api/device/v1/status
```

```json
{
  "company": "Acme Gears",
  "machines": [
    {
      "machine_id": 7,
      "machine": "VMC-01",
      "machine_ip": "192.168.1.10",
      "controller_name": "FANUC 0i-MF",
      "controller_type": "FANUC",
      "api_key": "3f9a…32 characters…",
      "program_path": "//CNC_MEM/USER/PATH1/",
      "program": {
        "file_id": 42,
        "program_name": "O1001.nc",
        "size_bytes": 1472,
        "sha256": "9f2c…64 hex characters…",
        "uploaded_at": "2026-10-22T08:00:00.000Z"
      },
      "programs_waiting": 2,
      "backup_request": null
    },
    {
      "machine_id": 8,
      "machine": "VMC-02",
      "machine_ip": null,
      "controller_name": "M80",
      "controller_type": "MITSUBISHI",
      "api_key": "b71c…32 characters…",
      "program_path": null,
      "program": null,
      "programs_waiting": 0,
      "backup_request": { "id": 9, "requested_at": "2026-10-22T08:05:00.000Z" }
    }
  ],
  "poll_seconds": 15
}
```

- `machines` lists every machine of the company that is switched on in MEXA.
- `machine_id` names the machine in calls 2, 3 and 4.
- `machine_ip` is its IP: the one its own telemetry reports, else the
  **Machine IP** typed on the Machines page (`null` when neither is known).
- `controller_name` is the **Controller** on the Machines page (`null` when
  not filled in).
- `controller_type` is the **Controller type** chosen there: `"FANUC"` or
  `"MITSUBISHI"` (`null` when not chosen) — how the gateway talks to that CNC.
- `api_key` is the machine's telemetry key — the one in its MQTT topic
  `machines/{api_key}/telemetry` — so the gateway can match the machines it
  already sends data for. Keep this answer as private as the token.
- `program_path` is the **Program path** on the Machines page: the folder on
  the CNC where its programs go, e.g. `//CNC_MEM/USER/PATH1/` on a Fanuc
  (`null` when not filled in). Write programs there, and read backups from
  there, on the CNC. It is typed in MEXA: never take it for a folder on the
  gateway PC without checking it against the folders that PC may use.
- `program` is the program in front of the machine's line (`null`: nothing
  waiting). Download it (call 2), write it, report it (call 4).
- `programs_waiting` counts it and the ones behind it.
- `backup_request` is not `null` when someone pressed **Backup now**. Read the
  program from the CNC and upload it (call 3). A request nobody answers within
  30 minutes lapses: it is no longer listed, and the page tells the person
  the gateway did not answer.

## 2. GET /program?machine_id=ID — download the program

```bash
curl -H "Authorization: Bearer $TOKEN" -o program.nc "https://SERVER/api/device/v1/program?machine_id=7"
```

The body is the file itself. The headers say what it is:

| Header | Example |
| --- | --- |
| `X-File-Id` | `42` — report this one (call 4) |
| `X-Program-Name` | `O1001.nc` (URL-encoded) |
| `X-Machine-Id` | `7` |
| `X-Machine` | `VMC-01` (URL-encoded) |
| `X-Sha256` | the file's SHA-256 — check it before writing to the CNC |
| `Content-Length` | `1472` |

`404 NO_PROGRAM` means nothing is waiting for that machine (someone deleted
it on the page after your `/status`). The same program can be downloaded as
often as needed until it is reported; each download shows it on the page as
sent to the gateway, at that time.

## 3. POST /backup — upload a backup

Multipart form data:

| Field | |
| --- | --- |
| `machine_id` | the machine, as `/status` lists it — required |
| `file` | the program file read from the CNC — required |
| `program_name` | its name on the CNC, e.g. `O1001.nc` (optional; else the file's name) |

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -F "machine_id=8" -F "program_name=O1001.nc" -F "file=@O1001.nc" \
     https://SERVER/api/device/v1/backup
```

```json
{
  "machine_id": 8,
  "machine": "VMC-02",
  "file": { "file_id": 43, "program_name": "O1001.nc", "size_bytes": 1472,
            "sha256": "…", "uploaded_at": "2026-10-22T08:06:10.000Z" },
  "answered_request": 9
}
```

The backup is saved on the server and listed on the Program Transfer page.
It answers the machine's open backup request (the person who asked is
notified). A backup can also be sent without a request — after a change on
the machine, or every night. If the CNC cannot be read, report it instead
(call 4).

## 4. POST /report — say what happened

JSON. One of three:

```json
{ "file_id": 42, "status": "DONE" }
{ "file_id": 42, "status": "FAILED", "message": "CNC memory full" }
{ "backup_request_id": 9, "status": "FAILED", "message": "CNC not reachable" }
```

`file_id` and `backup_request_id` already say which machine. You may add
`"machine_id": 7` as a check: a report about another machine's program is
then refused (`MACHINE_MISMATCH`) instead of recorded.

The answer to a program report names the machine's next program:

```json
{ "file_id": 42, "machine_id": 7, "machine": "VMC-01", "status": "DONE",
  "next_program": { "file_id": 44, "program_name": "O1002.nc", "size_bytes": 980,
                    "sha256": "…", "uploaded_at": "2026-10-22T08:01:00.000Z" } }
```

`next_program` is `null` when nothing else waits for that machine.

| Report | What the page shows | Who is notified |
| --- | --- | --- |
| program `DONE` | ✅ On the machine since 10:42 | the person who uploaded it |
| program `FAILED` | ❌ Refused by machine: *message* | the person who uploaded it |
| *(downloaded, no report yet)* | ⏳ Sent to the gateway at 10:42 — waiting for its report; flagged after 10 minutes | — |
| backup `FAILED` | ❌ Backup failed: *message*, and Backup now works again | the person who asked |
| *(backup asked for, no answer in 30 minutes)* | ❌ No answer from the gateway, and Backup now works again | — |

- `message` is required with `FAILED` (up to 500 characters) — write it for
  the person at the page: "Program O1001 is running", "CNC memory full".
- `DONE` and `FAILED` both take the program out of the line; a corrected
  program is uploaded again and waits at the end.
- `file_id` is the program's `file_id` from `/status` or the `X-File-Id`
  header.
- A backup that worked needs no report: uploading it (call 3) answers the
  request, so `status: DONE` with `backup_request_id` is refused — and so is
  a report with the backup's own `file_id` (`BACKUP_NEEDS_NO_REPORT`).
- The same report sent again (a retry after a lost answer) changes nothing
  and notifies no one twice: the answer then has `"unchanged": true`.
- A final result cannot be replaced by a different status or message
  (`409 REPORT_CONFLICT`). Reports for a removed program return
  `409 FILE_REMOVED`; upload a new program to request a new transfer.

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
| 401 | `TOKEN_MISSING` / `TOKEN_INVALID` | No token, a wrong one, or one S&T replaced or stopped |
| 401 | `TOKEN_REPLACED` | A machine token (`mxd_…`) from before 22 Oct 2026: ask S&T for the company's `mxg_` token |
| 403 | `COMPANY_DISABLED` | The company is switched off in MEXA |
| 403 | `MACHINE_INACTIVE` | The machine named is switched off in MEXA |
| 400 | `MACHINE_REQUIRED` | Send `machine_id` |
| 400 | `BAD_MACHINE_ID` | `machine_id` is not a whole number: use the one `/status` lists |
| 404 | `MACHINE_NOT_FOUND` | No such machine in the company: use the `machine_id` `/status` lists |
| 409 | `MACHINE_AMBIGUOUS` | (by name, from an older gateway) two machines share that name: send `machine_id` |
| 404 | `NO_PROGRAM` | Nothing is waiting for that machine |
| 404 | `FILE_NOT_FOUND` / `REQUEST_NOT_FOUND` | Report: no such program / backup request in the company |
| 409 | `REPORT_CONFLICT` / `FILE_REMOVED` | A final result conflicts with the report, or the program was removed |
| 400 | `MACHINE_MISMATCH` | The `machine_id` sent with a report is not the program's (or request's) machine; or a name or IP sent with `machine_id` is not that machine's |
| 400 | `BAD_STATUS` / `NO_MESSAGE` / `NOTHING_TO_REPORT` | Report: status must be DONE or FAILED; FAILED needs a message; send file_id or backup_request_id |
| 400 | `BACKUP_NEEDS_NO_REPORT` | Report: that file_id is a backup the gateway sent — a backup needs no report |
| 400 | `NO_FILE` / `BAD_UPLOAD` | Send the file as multipart field `file` |
| 400 | `BAD_NAME` / `BAD_TYPE` / `NOT_TEXT` / `EMPTY` | Not a usable program name or text file |
| 413 | `TOO_LARGE` | Over the size limit |
| 429 | | Too many calls (or too many wrong tokens) — wait and try again |
| 5xx | `SERVER_ERROR` | Try again later |

Retry a failed call after a pause; back off when the server keeps failing.
