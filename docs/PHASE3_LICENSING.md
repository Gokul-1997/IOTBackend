# Phase 3 — owner-controlled cloud and on-premise licensing

Status: **prepared, disabled and unreleased**, 26 October 2026. No customer has
been enrolled, no migration has been run against production, no signing keys
have been generated for deployment, and no deployment or payment integration has been enabled.

## What stays off now

The API example keeps `PHASE3_LICENSING_ENABLED=false` and `DEPLOYMENT_MODE=cloud`.
All frontend environments keep `phase3Licensing: false`. The owner sees no new
navigation, direct navigation is refused, new licensing endpoints return 404,
and no licensing heartbeat, database lookup or internet call runs while off.
Existing company, plan, report, transfer and mobile flows keep their behavior.

Phase 3 enforcement is opt-in **per company**: the owner creates its deployment
license after release/payment confirmation. Unenrolled legacy companies keep
their current behavior, even when the global cloud gate is enabled. Existing
company-plan expiry by itself is not an application-wide payment lock for those
legacy companies. Do not claim that all existing subscriptions were converted.

An on-premise deployment is different: `DEPLOYMENT_MODE=on_prem` always requires
licensing, regardless of the rollout flag. Do not distribute the current
unreleased cloud build as a customer-controlled on-premise product.

## The intended customer flow

1. Confirm payment manually. Create the company and its company-admin account
   with existing owner controls. The customer gets a company account, never an
   SNT super-admin account, Git access, SSH keys or the signing private key.
2. Create/assign a plan allowing at least **10 active machines**. In the future
   Deployment licenses page, choose that company, Cloud or On-premise, an
   allowance of **10**, a required future expiry and a payment reference.
3. The effective allowance is the smaller of the license and assigned plan
   allowances. Machine creation/reactivation keeps its company-row transaction
   lock; an eleventh active machine is refused. Deactivated machines release
   capacity. If an allowance is lowered below existing usage, access is blocked
   until the owner resolves the mismatch; the system does not pick machines to
   delete or silently disable.
4. Cloud customers open the owner's HTTPS service. Their server-side entitlement
   comes from the owner's database. On-premise customers get a versioned runtime
   installation and a one-time installation credential, with one company and
   installation ID bound to the license. Local company IDs must match the owner-
   issued company ID. Provision only that customer's tenant data on its server.
5. Before expiry, the owner records renewal/payment and extends the license.
   If the assigned company plan also expired, renew/reassign that plan too.
   Renewal never changes `companies.is_active`; a deliberately disabled company
   remains disabled. Suspending is reversible; revocation is irreversible.
   A revoked company's production license cannot be recreated through the UI;
   replacement requires an owner-reviewed recovery/provisioning process.

The initial UI defaults to 10 machines. It also supports editing limits,
renewing, suspending/resuming, revoking, rotating installation credentials and
viewing an append-only change history. Customer and installation identity/mode
are immutable. Raw installation credentials appear once, remain in browser
memory only and clear after five minutes or navigation; store them securely.

## Enforcement and internet behavior

The shared server gate covers login, refresh-token issuance, authenticated HTTP
requests, gateway operations, socket authentication and already-open sockets.
Creation/reactivation also checks capacity inside the existing transaction.
It applies equally to web and mobile because both use the same API.

On-premise checks use HTTPS, a fresh random challenge, and an Ed25519 signature
verified against the pinned public key. The lease binds company, installation,
license ID, revision, allowance and absolute expiry. Altered signatures,
cross-company/install replays, expired leases and unexpected redirects are
refused. The private signing key stays only on the owner's cloud authority.
Installation credentials are random and stored as SHA-256 hashes by the owner.

Only one API process may hold an installation's active lease. A random per-boot
identifier is signed into the lease, and a row lock prevents a copied credential
from opening another instance concurrently. Use one API process for an on-premise
site. After a crash/restart, a new process may wait up to 120 seconds for the old
lease to expire; an owner credential rotation also clears that reservation.
This reduces casual copying and does not replace the host-admin trust limit.

There is **no offline grace mode**. The installation obtains a lease at startup,
rechecks once per minute, and blocks application access after a failed check.
The normal lease lasts 120 seconds and never exceeds the paid expiry. It is
kept only in memory: restarting without internet does not restore access.
Request timeout is five seconds; active sockets are swept every ten seconds.
Revocation is therefore bounded by check/lease timing, not instantaneous while
the installation is unreachable. A monotonic deadline and rollback detection
prevent clock rollback from extending an already accepted lease.

One single-flight check serves all users on that installation. Cloud entitlement
reads coalesce per company for up to five seconds and never cache beyond expiry.
Socket checks are grouped by company. There is no license request per telemetry
packet, machine card, web user or mobile user. These bounds do not certify peak
server capacity; retain the load limits in PLATFORM_AUDIT_2026-10-24.md.

Locking a subscription restricts the application, reports and program-transfer
gateway. It does **not** stop CNC operation, erase production history, discard
accepted journal entries or shut down the collector. Durable telemetry capture
and journal draining continue. This avoids turning a payment/network problem
into lost manufacturing records. No payment provider or automatic webhook is
connected: a payment reference is an owner-entered audit reference.

## Source protection and ownership

Cloud hosting gives the owner control of server code, deployment accounts and
signing keys; browser JavaScript is inherently delivered to users. Use named
owner accounts, MFA, a private registry, restricted CI credentials and VPN/SSH
access approved for each customer. Do not share a master account between sites.

The prepared build context excludes Git history, environment secrets, private
keys, tests and source maps. Runtime images run without root and Compose drops
capabilities and uses read-only filesystems with dedicated writable storage.
These reduce exposure; they do not encrypt installed Node JavaScript. A person
with host/root or Docker-administrator access can inspect images, copy software
or patch checks. Containers, packaging, compilation and obfuscation cannot give
an absolute confidentiality/tamper-proof guarantee on client-controlled hardware.
For stronger protection, supply an owner-administered appliance with agreed
restricted administration, or keep sensitive functions in the owner's cloud.
See [Docker's host/daemon security boundary](https://docs.docker.com/engine/security/).

## Future owner activation — only when release is authorized

1. Restore a backup into an isolated staging database. Establish a complete,
   verified schema and provision narrow API/collector roles, TLS, Redis and MQTT
   access controls. The repository contains upgrades, **not a complete fresh-
   database baseline**. The retired reset migration must never initialize a
   customer or production database. This is a release blocker, not a reason to
   set the verification flags without checking.
2. Apply reviewed migration `061_deployment_licensing.sql` using the existing
   checksum migration runner, after all required prior migrations. It creates
   license and immutable event tables and enrolls nobody. Test the schema on
   the actual supported PostgreSQL/Timescale version before production rollout.
3. In an owner-only secure directory, run `node tools/phase3/keygen.cjs <new-dir>`
   once. It refuses overwriting existing keys. Back up the private key securely;
   configure `LICENSE_SIGNING_KEY_FILE` only on the cloud authority. Distribute
   only the public verification key to installations. Release/image-signing
   keys must be separate from this license key.
4. After explicit release approval, enable the cloud API flag and build the
   owner frontend with `phase3Licensing: true`. Both gates and SNT authorization
   are required. The current committed frontend remains false. Create licenses
   individually; review tenant/machine counts before enrolling existing clients.
5. Build private runtime images from a sanitized context:

   ```sh
   node tools/phase3/prepare-context.cjs /tmp/mexa-release-context
   docker build -f /tmp/mexa-release-context/Backend/deploy/phase3/Dockerfile.api /tmp/mexa-release-context
   docker build -f /tmp/mexa-release-context/Backend/deploy/phase3/Dockerfile.web /tmp/mexa-release-context
   docker build -f /tmp/mexa-release-context/Backend/deploy/phase3/Dockerfile.collector /tmp/mexa-release-context
   ```

   Use reviewed base-image digests through the Dockerfile build arguments in
   owner CI, scan and sign releases, push to the private registry, and record
   the resulting immutable runtime image digests. No image has been built or
   published by this change. The web image uses same-origin `/api` and sockets;
   it does not send factory traffic to the public STM cloud. This web artifact
   is not an Electron/mobile server-switching installer. Mobile already supports
   a site-specific `EXPO_PUBLIC_API_BASE_URL` at build time; clear Metro's cache
   when changing it and verify the resulting artifact. Configure the gateway's
   `MEXA_URL` to the site's HTTPS origin. Electron needs its explicit site-specific
   endpoint configuration and validation before release.

6. Give the customer's server only the runtime release directory: Compose,
   verified image digests and the installer, plus protected site configuration.
   Use an external PostgreSQL/Timescale database, Redis and MQTT broker already
   provisioned by the owner. Copy the `.env.example` templates to `release.env`,
   `api.env` and `collector.env` **outside Git**; use owner-only `0600` files.
   Replace all examples, use different database users and unique JWT secrets,
   verified TLS and a persistent MQTT client ID. For these simple environment
   files use literal URL-encoded/base64url values; shell interpolation is refused.
7. Store `secrets/installation-token`, `secrets/license-public-key.pem` and the
   public CA bundle `secrets/database-ca.pem`. API/collector container users must
   be able to read their mounted files without making credentials world-readable;
   verify UID ownership on the target Linux host. The signing private key never
   belongs in this directory. Serve the loopback web port through the site's
   HTTPS reverse proxy; do not expose API, PostgreSQL, Redis or collector ports.
8. Run installer preflight only:

   ```sh
   node tools/phase3/install.cjs /owner-controlled/release-directory
   ```

   It validates configuration without starting services. Only after actual
   schema/restore verification set `SCHEMA_VERIFIED=true` and
   `BACKUP_RESTORE_VERIFIED=true`. Starting later also requires
   `PHASE3_RELEASE_APPROVED=true` and both `--start --enable-phase3` arguments.
   There is no remote download-and-execute installer and no automatic migration.

For the owner's existing cloud deployment, keep infrastructure and current
endpoints under the owner's accounts. Configure the private signing-key file,
enable the cloud gate only after migration/release approval, and enable the
owner frontend build separately. Runtime containers used for cloud must explicitly
set `DEPLOYMENT_MODE=cloud`; the customer API image defaults to mandatory on-premise
licensing. Do not mount installation credentials or share authority keys with
customer installations. For signing-key replacement, use a planned maintenance
window and coordinated public-key distribution/restart; automatic multi-key
rotation is not implemented.

## Verification performed

The backend regression suite, licensing security/installer tests, frontend suite
and collector suite pass. Production and on-premise web builds compile. A local
browser verified that the owner sees no Phase 3 entry, direct navigation is
blocked and no licensing HTTP request occurs while disabled. A new temporary
PostgreSQL cluster verified migration 061, the ten-machine cap, hash redaction,
owner changes, signed lease exchange, token rotation, suspension/resume,
expiry/renewal and audit UPDATE/DELETE rejection. Its generated test keys and
database were removed. The sanitized context exported successfully with no
repository metadata, secret files, tests or source maps.

## Required release validation and operations

The Docker engine is unavailable in the current workspace. Dockerfiles/Compose
are staged templates, not a tested Linux installation or production certificate.
Before Phase 3 opens, test builds on the target architecture, external database
and Redis TLS, MQTT certificates, mounted-file ownership, one-tenant provisioning,
startup/restart, health endpoints and backup restoration. Test creating ten
machines and refusing eleven; expiry/renewal, suspension/revocation, a disabled
company, tampered/replayed leases, internet loss, clock changes and active socket
cutoff. Verify no other customer's data or signing key is in any release layer.

Back up PostgreSQL, private API storage and collector journal volumes with
documented retention. Keep image digests, protected configuration and schema
version together. For upgrades, take/verify backups, review migrations, stop new
writes safely, drain accepted telemetry and replace images. Never remove volumes
with `docker compose down -v` during an update. Roll back application images only
when schema compatibility was verified; restore the tested backup when a database
rollback is needed. Monitor licensing failures, expiry, database readiness, disk
space, journal backlog and TLS certificate lifetime. Keep owner support access
explicit and audited; never install an undisclosed remote-access backdoor.
