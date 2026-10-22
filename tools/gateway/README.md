# MEXA gateway — moves programs into the machine

The MEXA server never connects to a machine. A small program next to the
machine — `mexa-gateway.js` — asks the server every 15 seconds:

```
 Laptop / browser            MEXA server                    Gateway (PC at the machine)        Machine
 ────────────────            ───────────                    ───────────────────────────        ───────
 Program Transfer →  ──────▶ saves O1001.nc         ◀────── GET /status  "a new program?"
 Upload program              for that machine       ──────▶ yes: O1001.nc, WAITING
                                                    ◀────── GET /program
                                                    ──────▶ the file + its SHA-256
                                                            checks it, writes it into ───────▶ program folder
                                                    ◀────── POST /report DONE
 page: "On the machine       ◀── notification
        since 10:42"
```

Backups go the other way: **Backup now** on the page → the gateway sees the
request on its next `/status` → sends the machine's program with
`POST /backup` → it appears under Backups.

## Try the whole flow on a laptop

1. In MEXA: **Program Transfer → choose the machine → Gateway token →
   Create token → Copy**. (Shown once. One token per machine.)
2. Install Node.js 20 or newer. Nothing else.
3. Start the gateway, with a folder standing in for the machine:

   **Windows (PowerShell)**
   ```powershell
   $env:MEXA_URL="https://stmapi.stmcnc.com"
   $env:MEXA_TOKEN="mxd_...paste..."
   $env:PROGRAM_DIR="C:\MEXA\VMC-1"
   node mexa-gateway.js
   ```

   **macOS / Linux**
   ```bash
   MEXA_URL=https://stmapi.stmcnc.com MEXA_TOKEN=mxd_... PROGRAM_DIR=./VMC-1 node mexa-gateway.js
   ```

   It prints `Connected: machine VMC-1; programs go to …`.
4. In MEXA: **Upload program** → choose the `.nc` file on your laptop →
   **Upload**.
5. Within 15 seconds the file is in `PROGRAM_DIR`, the page says
   **On the machine since …**, and the bell tells the person who uploaded it.
6. Press **Backup now**: the newest file in `PROGRAM_DIR` is sent back and
   listed under **Backups**.

Stop it with Ctrl+C.

## At a real machine

| Setting | |
| --- | --- |
| `MEXA_URL` | the MEXA server (or the API address shown in the Gateway token dialog) |
| `MEXA_TOKEN` | that machine's token |
| `PROGRAM_DIR` | the folder the CNC reads programs from: its network share, a DNC folder, a mapped drive |
| `BACKUP_FILE` | optional: the file to send on **Backup now** (default: the newest file in `PROGRAM_DIR`) |

Run it as a service so it starts with the PC (Windows: Task Scheduler "At
startup", or NSSM; Linux: a systemd unit with `Restart=always`). One gateway
per machine; several can run on one PC.

A controller that is not reached through a folder (FTP, FANUC FOCAS,
Mitsubishi, Siemens tools…) needs only the two functions marked **MACHINE**
in `mexa-gateway.js` replaced: `writeToMachine(name, data)` and
`readFromMachine()`. The rest — the calls, the SHA-256 check, the reports,
the retries — stays.

## What it tells the page

| On the machine side | The page shows |
| --- | --- |
| program written | ✅ On the machine since 10:42 |
| download damaged, unusable name, folder not writable | ❌ The machine could not use it: *reason* |
| nothing to back up / backup refused | ❌ Backup failed: *reason* |
| server or network down | nothing — it tries again (15 s, then slower, up to 5 min) |
| token wrong or revoked | it stops: make a new token |

The full API: `docs/PROGRAM_TRANSFER_API.md`. Tests:
`__tests__/tools/mexa-gateway.test.js` (runs against the real device routes).
