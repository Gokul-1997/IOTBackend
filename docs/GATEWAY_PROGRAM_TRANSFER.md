# Gateway architecture and CNC Program Transfer

## Implemented boundary

The gateway environment is Windows with Node-RED. The user's embedded team owns
all communication between the gateway and CNC controllers. This implementation
covers the application frontend, backend, database and gateway-facing transport:
commands/files go to the assigned gateway; actual controller results/files come
back. It does not install a Python CNC agent, emulate a controller or replace the
existing machine-data collection flow.

The previous system already had immutable company/machine file storage, durable
jobs, checksums, backup-before-replacement and tenant constraints. Its main gaps
were one device token per machine, no shared-gateway assignment/capacity, buffered
uploads and an operator screen mixed with technical connection settings.
The redesign reuses those foundations through versioned `/api/programs/v3`
operator APIs and `/api/gateway/v1` gateway APIs. The previous unversioned
`/api/programs` and per-machine `/api/device/v1` endpoints have been removed.
Use the gateway API for every new transfer and backup integration.

## Recommended deployment

Use one shared gateway per plant/reachable network segment as the starting point.
A company gateway can serve several plants when network access and organizational
policy permit. A dedicated machine gateway is an assignment with one machine.
Add gateways for network isolation, manufacturer hardware requirements or measured
capacity limits; a company does not need another application server per machine.

| Choice | Benefit | Trade-off |
| --- | --- | --- |
| Shared plant gateway | Lower hardware/update cost; centralized local configuration | Its outage affects its assigned machines; measure capacity |
| One gateway per machine | Failure/network isolation; fits vendor-specific hardware | More devices, credentials and updates |
| Several gateways per company | Divides plants or workload using the same backend | Each machine still needs one active owner |

20, 50 or 100 machines is a commissioning target, not a universal guarantee.
Measure actual controller response times, data sampling, CPU/memory, file sizes
and network failures. File-operation concurrency is bounded separately from
telemetry (default two, configurable 1–16 per gateway). The database allows one
open file operation per machine. This is single-owner operation, not automatic
active-active controller failover.

## Communication

**Existing MQTT telemetry remains unchanged.** MQTT is suitable for telemetry
and small wake/status messages; broker acknowledgement is not controller-write
proof. The [MQTT 5 standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
defines persistent sessions, expiry and request/response correlation for an
embedded team that chooses those capabilities.

**Program control and file bytes use outbound HTTPS.** The gateway collects a
durable command with a bounded 24-second long poll, streams files and reports
progress/results. A process-local wake reduces latency; a bounded indexed database
recheck supports separate API instances. Waiting HTTP requests hold no database
connection. No custom socket file protocol, gRPC deployment, new cloud service
or inbound plant port is needed. Existing authenticated sockets update the web UI;
visible disconnected pages use bounded recovery instead of duplicate fast polls.

The embedded team selects CNC-side protocols according to real controller support:
SFTP/FTPS for supported secure file access, explicitly isolated legacy FTP where
necessary, SMB or manufacturer-specific interfaces where documented. The server's
protocol field is a profile label, not a promise that a driver is installed.
Capabilities remain off until the assigned gateway reports them for the exact
configuration version.

[FANUC's FOCAS2 documentation](https://www.fanucamerica.com/products/software/focas2-library)
describes CNC file read/write access; the [manufacturer catalogue](https://www.fanucamerica.com/docs/default-source/cnc-files/cnc-catalog-plus-series.pdf)
identifies platform-specific libraries and option dependencies. Node-RED function
and environment integration follows the [official function guide](https://nodered.org/docs/user-guide/writing-functions)
and [environment-variable documentation](https://nodered.org/docs/user-guide/environment-variables).
The application does not guess controller capabilities from brand names.

## Simple operator workflow

The signed-in account supplies the company boundary; users cannot select another
tenant by changing an input. Choose a plant and machine within that company.

1. Drop/select a local program into **Server files**. Upload is allowed without an
   online gateway; the reference is saved on the application server.
2. Select the saved file, choose Send, review destination/replacement and confirm.
   The assigned gateway receives the command. Completion requires embedded-team
   safety validation and exact controller read-back checksum.
3. **Machine files** requests a fresh directory listing when supported. Browse
   below the configured program root, retrieve a selected file to the server,
   then download the verified saved copy.
4. **Backup Current Running Program** requests actual newly read controller bytes.
   It never substitutes an older server reference. Each click creates separate
   command/version history. Unsupported identification produces a clear failure.
5. Restore a saved backup through a new confirmed, verified machine write.

The queue/history shows stages, bytes, deadlines, failures and verified completion.
A percentage alone cannot complete a job. Setup is a separate collapsed admin
area: register a gateway, assign its local controller profile and program path
once. Operators do not re-enter IP addresses or protocol secrets for transfers.

## Security and recovery

- Company/plant ownership, current role/company grants, active states and exact
  gateway assignment apply to files, commands and results. Tokens are hashed,
  shown once and checked on every gateway request. Private command leases never
  go to operator APIs, sockets or logs.
- Assignment changes and token rotation wait for open work. Retained database
  guards also prevent legacy job/token creation for an assigned machine. Stop and
  reconcile the old physical writer before switching its assignment; removal of
  its HTTP routes does not prove an earlier physical operation finished.
- Commands and uploads use idempotency keys. The same request/capture after a lost
  reply returns its existing result; a new backup click produces a new version.
- Streamed disk staging enforces text/name/size/hash checks before immutable
  publication. Checksums cover actual received bytes. Existing server files are
  not overwritten to emulate a controller backup.
- SEND/RESTORE require explicit user confirmation plus embedded-controller safety
  and SHA-256 read-back attestations. Authorized replacement first preserves the
  actual controller file. The embedded team must protect executing/selected
  programs using its real controller API and write interlocks.
- Redelivery is recovery of the same job/lease. Uncertain or expired physical
  writes remain fenced until actual controller reconciliation; they are not
  blindly repeated or turned into successful uploads. Only queued jobs cancel.
- Transfer changes have transactional audit rows. Post-commit socket/inbox delivery
  must not undo physical-work history if notification delivery fails.

The Windows/Node-RED team calls the documented HTTPS endpoints from its existing
machine integration and keeps a durable physical-operation ledger and local
spool. Its result reports must reflect actual controller reads and writes. The
application supplies the API contract; controller implementation belongs to the
embedded team.

## Deployment and team handoff

Read [the complete gateway API contract](GATEWAY_PROGRAM_TRANSFER_API.md).
It includes endpoint bodies, capability reports, job leases, current backup,
replacement capture, errors, Windows/Node-RED setup and recovery responsibilities.
The frontend exposes a downloadable copy for the embedded team. No Postman
collection is required.

Before upgrading an existing device integration, follow the [legacy cutover
check](GATEWAY_PROGRAM_TRANSFER_API.md#retiring-the-previous-device-flow). Open
legacy jobs must be reviewed before deployment because they continue to block
new work for their machine. The code removal does not cancel them or delete data.

Apply reviewed **049_gateway_transfer.sql** and prerequisites if not already
applied, then deploy API and frontend. Retiring the old routes requires no
additional migration. Existing migration checksums, stored files and job history
remain unchanged. Keep the historical `PROGRAM_TRANSFER_DIR` when old saved file
records still use it. Rollback refuses to
remove gateway configuration, work or audit history. Back up the database,
server file root and embedded gateway's own persistent ledger/spool together.
Adjust reverse-proxy body/idle timeouts for the configured file limit and long
poll, trust the plant CA, and protect the Node-RED editor/service account.

Source tests do not establish live CNC compatibility. The embedded team still
needs to commission its controller profiles, safety semantics, program identity,
file access, restart reconciliation and physical interlocks. No production
migration, live controller operation or deployment is performed by these changes.
