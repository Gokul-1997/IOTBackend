# Energy data integrity review — 28 October 2026

Scope: the web Energy Dashboard, its meter/tariff/export APIs, and MQTT electrical readings through durable journal and hourly aggregation. Validation used mocked services and disposable local PostgreSQL fixtures. No production connection, migration, historical rewrite or deployment was performed.

## Corrections

- Meter queries now enforce both the reading's recorded company and the machine's current company/plant. Future readings cannot appear in pickers, latest values, trends or summaries. Stale tariff rows cannot expose another company's machine name or transfer its tariff to a new owner.
- Energy sources consistently apply company, plant, active machine, search and date filters. The raw counter query remains one bounded pass, with daily and monthly cost aggregates produced from the same pass. Date windows are plant calendar days in Asia/Kolkata; ranges are limited to 366 days.
- Missing, single, reset-only and implausible counter intervals remain unknown. A real unchanged positive counter measures 0. Accepted consumption remains visible with partial coverage; incomplete period cost and energy-per-part are unavailable. Period and month completeness require measured days for every selected machine.
- Cost estimates use each machine's configured tariff, including overrides. Mixed currencies and missing prices are not combined into a purported full cost. Charts use API prices and preserve unknown-day gaps; changing Day/Week/Month makes no request. Estimates use current settings, not historical billing rates.
- Exports include all matching machines, including fleets larger than 200, with currency and coverage columns. Paging, IDs, dates, tariff values and currencies are validated.
- Meter selection follows the dashboard machine filter. Obsolete responses are cancelled; changed filters and failed requests cannot relabel old figures as new data. A failed meter load is visible. Polling remains suspended for background tabs and confirmed absence of meters. Seven-day meter reads use the existing heavy-request admission limiter.
- Electrical ingestion parses complete finite values, preserving signed power and power factor. Invalid strings do not become positive usage. Phase-neutral voltage is not substituted for line-to-line voltage. Values that cannot fit REAL or INT storage become unknown rather than poisoning a journal batch.
- Recovering a short missing-meter interval allocates energy across its actual meter timestamps without adding runtime twice. Long missing-meter intervals retain known consumption in ingest_gaps without guessing an hour/shift. Same-second changes are retained once; small increments are no longer rounded away per packet.

## Meaning and limits

The dashboard totals accepted telemetry counter changes inside the requested range. A first reading establishes a baseline; it does not establish earlier consumption. Zero total-register readings are treated as dropped reads according to the existing device contract. A downward positive reading is treated as a reset/replacement; hardware reset identifiers are not available to distinguish every faulty positive reading from a real reset. These data quality limits prevent an unconditional accuracy guarantee.

Energy by Shift uses production_hourly allocations. It is labeled with that source and can differ from raw counter totals because long gaps cannot be assigned reliably. Hourly 0 cannot distinguish missing meter allocation from measured zero, so the shift API leaves it unknown. The raw counter and meter detail charts still preserve genuinely measured zero.

Collector changes affect subsequent ingestion. Historical hourly rows have not been rebuilt, and older phase-neutral values already stored without provenance cannot safely be relabeled automatically. Any historical repair requires a separate scoped reconciliation against source readings; it must not invent missing readings.

## Validation

- Full Backend suite: 2453 tests across 127 suites.
- Full collector suite: 447 tests across 24 suites.
- Frontend unit suite: 389 tests across 49 files; production build passes with existing bundle/style budget warnings.
- Actual disposable PostgreSQL: 50 dashboard assertions, 32 meter flow assertions and 5 typed storage-boundary checks. These cover company/plant isolation, moved machines, inactive machines, future data, search, tariffs, resets, outliers, unknown/zero readings and exports over 200 machines.
- Browser regression suite: 24 checks passed, covering tariff overrides, chart grouping, missing readings, measured zero, plant dates in another browser timezone, filter failures, request cancellation and meter filtering.

These checks establish the tested behavior. Synthetic local timings are not a production concurrency benchmark or a guarantee about every deployed dataset.
