# Production data integrity — 29 October 2026

## Findings and corrected behavior

The Factory shift bars previously used all recorded machine output while the
Actual vs Target rows used only machines with positive current job targets.
Both numbers could be calculated correctly yet describe different populations.
The shift bars and production comparison trend now use the same target-covered
actual output as their numeric comparison. Without targets they use recorded
output. Total pieces and Production Report continue to include all recorded
output. The metric explanation describes this coverage; no extra per-shift
"Targeted machines:" or standalone Units line is displayed.

A separate source-data defect was confirmed by bounded read-only inspection of
the affected machine's original counters: repeated `11 → 5 → 11` readings were
credited as six new parts on every rebound. Collector admission now retains a
counter high-water mark across unexplained backward readings. Only a confirmed
near-zero reset lowers that mark. Its baseline and uncertainty flag are saved
in the existing durable journal state, survive restarts and Redis loss, and do
not change the raw counter or process status. The collector records regression
metrics and logs the first transition into uncertainty. An ambiguous reset can
leave output uncounted; the software must not invent the missing quantity.

Part Timing applies matching counter epochs/high-water marks so it cannot turn
the same rebound into extra part rows. This fixes future calculation behavior;
it does not establish how many physical parts the machine actually made.

Other confirmed defects corrected during the related-page audit:

- Live machine list/detail no longer multiply historical rollup quantities by
  the component configured today. Stored report units remain unchanged.
- Factory, Charts, OEE, and Operator production scopes use plant local dates,
  shift starting dates, overnight tails and overlapping first partial hours.
  Selected shifts constrain the Factory bars as well as its headline/trend.
- Date ranges and hourly/summary records reject future readings or unfinished
  cached shift summaries and enforce machine/source company ownership.
- Factory monthly energy stops at the selected day and observation time.
- Factory overnight quality uses the shift starting day; upcoming-shift quality
  is excluded. OEE live status uses the same 60-second cutoff as Factory/Live.
- Legacy Operator reporting aggregates production and quality separately and
  deduplicates assignment pairs. Extra reject entries no longer multiply hours
  or produced quantities.
- OEE dashboards, Machine OEE tables, and exports retain fleets above 200
  machines. The existing endpoint can return the complete authorized fleet in
  one calculation while normal API pagination remains bounded.
- Factory/OEE filter changes clear earlier selections' figures before loading,
  so a failed request cannot present old counts under new filter labels.

## Historical correction and rollout

No production database rows were changed during this audit. Existing hourly
totals containing counter rebounds need reconciliation against a verified
physical/controller count. The user has requested that count from the machine
team. Do not replace old totals with a replay estimate or zero: neither is a
verified production count. Reconcile dependent production/OEE summaries together
when evidence and an approved correction window are available; energy readings
must not be rewritten as part of a production-only correction.

Deploy Backend, FrontendIOT, and collector updates together. The frontend's new
comparison trend reads `trend.actual`, and its complete-fleet OEE request uses
`all_machines=true` on the existing endpoint. This patch needs no new database
migration. Existing migration 062 remains a prerequisite for battery diagnostics
from the earlier release.

## Reproducible verification

Verified: 2,500 Backend tests, 499 collector tests, 398 frontend unit tests,
39 browser checks, and 66 actual PostgreSQL fixture assertions. The frontend
production build passes with its existing bundle/style warning thresholds.

The regular Backend, FrontendIOT, and collector suites cover date validation,
tenant/plant scope, future/upcoming shifts, no targets, partial/overnight/24-hour
windows, counter resets and oscillations, replay/restart behavior, full exports,
failed filters and fleets above 200 machines.

Opt-in SQL fixtures use disposable local PostgreSQL only and never load `.env`:

```sh
TEST_DATABASE_URL=postgresql://localhost:55486/postgres node __tests__/fixtures/verify-production-dashboard.cjs
TEST_DATABASE_URL=postgresql://localhost:55486/postgres node __tests__/fixtures/verify-oee-production.cjs
node __tests__/fixtures/verify-operator-report.cjs
```

The first two fixtures use session-local temporary tables. The Operator fixture
creates and removes its own disposable Unix-socket cluster; configure
`OPERATOR_FIXTURE_PG_BIN` if PostgreSQL is installed elsewhere.

Frontend integration checks run with `playwright.production-integrity.config.ts`.
Their API/WebSocket fixtures block external service traffic and verify the
reported count mismatch alongside report navigation, large fleets, plant date
handling, mobile layout and dark theme.
