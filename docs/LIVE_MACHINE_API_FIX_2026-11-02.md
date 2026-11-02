# Live machine detail endpoint repair

Affected route: `GET /api/dashboard/live/:machine_id`.

## Changes

- If `ENERGY_V2_ENABLED=true` is set before migration 064, the missing optional
  readiness table now means the new pipeline is not ready. Machine detail,
  meter readings and maintenance supply retain their installed data source.
  Other database errors still propagate. Warnings are bounded and readiness
  is retried, so a subsequently installed migration is discovered.
- The legacy latest-energy lookup used a broad observation view, performing
  sparse-claim lookups for hundreds of thousands of raw rows. It now filters
  valid raw counters before source suppression, reads claim timestamps once,
  and merges the latest eligible reading from each source. It retains the
  original tenant/device filters, event-time ordering, 30-day quiet-meter
  search, standalone precedence, shift guards and unknown-value semantics.
- This repair needs no new migration and does not activate the v2 pipeline.

## Verification

Read-only checks against the configured database reproduced machine 15's
machine-detail flow successfully. Before the change, its energy query took
about 13.1 seconds including the round trip. The old latest-counter query alone
measured 12,538 ms in PostgreSQL; the optimized combined energy query measured
660 ms. A subsequent complete service check measured 714 ms for its energy step.
These are query measurements, not authenticated HTTP latency or an SLA.

The original and optimized queries returned identical results at the same
snapshot. Thirteen PostgreSQL cases covered independent sparse messages,
zero/invalid standalone claims, NULL device time, event-versus-receipt order,
quiet/future/out-of-range readings, tenant/device isolation, no active shift,
unknown consumption and existing counter-reset guards. The complete backend
suite passed: 149 suites, 2,724 tests. No production data was changed.

## Deployment and remaining live verification

Deploy this Backend commit to the existing API checkout and restart its
existing process. Keep `ENERGY_V2_ENABLED=false` unless the separate verified
backfill/cutover has been completed. No database reset or migration is needed
for this patch.

The public endpoint requires authentication and returned 401 to an anonymous
check. The authenticated production failure and server log have not been
verified: the available IoT SSH key was rejected. Use an explicitly authorized
server login to inspect the exact error, deploy the patch, and check a signed-in
request plus the machine page. Do not report live recovery solely from the
read-only database reproduction.
