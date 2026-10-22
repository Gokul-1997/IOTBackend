# MEXA gateway — moves programs into the machines

The MEXA server never connects to a machine. One small program on the
factory network — `mexa-gateway.js` — asks the server every 15 seconds, with
the company's one token, about **all** the company's machines at once:

```
 Laptop / browser            MEXA server                    Gateway (one PC, all machines)        Machines
 ────────────────            ───────────                    ──────────────────────────────        ────────
 Program Transfer →  ──────▶ saves O1001.nc         ◀────── GET /status   (one call, every machine)
 Upload program              in VMC-01's line       ──────▶ VMC-01: O1001.nc waiting (2 in line)
                                                    ◀────── GET /program?machine=VMC-01
                                                    ──────▶ the file + its SHA-256
                                                            checks it, writes it into ──────────▶ VMC-01's folder
                                                    ◀────── POST /report DONE
                                                    ──────▶ next_program: O1002.nc → same again
 page: "On the machine       ◀── notification
        since 10:42"
```

Two programs for one machine go one after the other; different machines do
not wait for each other. Backups go the other way: **Backup now** on the page
→ the gateway sees the request on its next `/status` → sends that machine's
program with `POST /backup` → it appears under Backups.

## Try the whole flow on a laptop

1. Ask S&T for the company's gateway token (S&T Super Admin → Company
   Management → the company → **Gateway** → Make token → Copy). It starts
   `mxg_` and is shown once. One token for all machines.
2. Install Node.js 20 or newer. Nothing else.
3. Start the gateway, with a folder standing in for the machines:

   **Windows (PowerShell)**
   ```powershell
   $env:MEXA_URL="https://stmapi.stmcnc.com"
   $env:MEXA_TOKEN="mxg_...paste..."
   $env:PROGRAM_DIR="C:\MEXA\machines"
   node mexa-gateway.js
   ```

   **macOS / Linux**
   ```bash
   MEXA_URL=https://stmapi.stmcnc.com MEXA_TOKEN=mxg_... PROGRAM_DIR=./machines node mexa-gateway.js
   ```

   It prints `Connected to <company>: N machine(s) served here; …`.
4. In MEXA: **Program Transfer → choose a machine → Upload program** → choose
   the `.nc` file on your laptop → **Upload**. Upload a second one for the
   same machine to see the line.
5. Within 15 seconds both are in `PROGRAM_DIR/<machine name>/`, one after the
   other, the page says **On the machine since …**, and the bell tells the
   person who uploaded them.
6. Press **Backup now**: the newest file in that machine's folder is sent
   back and listed under **Backups**.

Stop it with Ctrl+C.

## At the factory

| Setting | |
| --- | --- |
| `MEXA_URL` | the MEXA server |
| `MEXA_TOKEN` | the company's gateway token (`mxg_…`, from S&T) |
| `PROGRAM_DIR` | the folder that holds one folder per machine, named as in MEXA (default `machines`) |
| `MACHINE_DIRS` | optional JSON: each machine's own folder, e.g. `{"VMC-01":"\\\\cnc01\\programs","VMC-02":"D:\\DNC\\VMC-02"}` — then only these machines are served by this PC |

Run it as a service so it starts with the PC (Windows: Task Scheduler "At
startup", or NSSM; Linux: a systemd unit with `Restart=always`). One gateway
serves every machine; with `MACHINE_DIRS`, two PCs can split the machines
between them.

A controller that is not reached through a folder (FTP, FANUC FOCAS,
Mitsubishi, Siemens tools…) needs only the two functions marked **MACHINE**
in `mexa-gateway.js` replaced: `writeToMachine(machine, name, data)` and
`readFromMachine(machine)` — `machine.machine` is its name and
`machine.machine_ip` its IP. The rest — the calls, the SHA-256 check, the
reports, the line, the retries — stays.

## What it tells the page

| On the machine side | The page shows |
| --- | --- |
| program written | ✅ On the machine since 10:42 (and the next one goes) |
| download damaged, unusable name, folder not writable | ❌ Refused by machine: *reason* (and the next one goes) |
| nothing to back up / backup refused | ❌ Backup failed: *reason* |
| server or network down | nothing — it tries again (15 s, then slower, up to 5 min) |
| token wrong, replaced or stopped | it stops: ask S&T for the token |

The full API: `docs/PROGRAM_TRANSFER_API.md`. Tests:
`__tests__/tools/mexa-gateway.test.js` (runs against the real device routes).
