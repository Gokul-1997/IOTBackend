# Dashboard changes - 25 November 2026

The web application and API implement the requested dashboard and report changes.

| Request | Result |
| --- | --- |
| AI accuracy | Replies use the current question's company-scoped, read-only report results. Numerical claims are checked against measured values, units, rounding, and changes in the same aggregate metric. Unsupported figures are replaced with a server-rendered summary of actual values, or a clarification when a safe summary is unavailable. Report sources show their database read time. This checks figures; it does not certify free-form prose or infer machine failure causes. |
| Operator estimate | Sum each assigned machine's measured running seconds divided by its current component cycle seconds. Fleet totals count shared machines once. Missing valid cycle time on any running machine makes the estimate unavailable. The screen identifies the selected period and current-cycle basis; this is not a reconstruction of historical component changes. |
| Alarm Pareto | Count alarm occurrences by type and code, rank descending, and plot cumulative percentage. The top 20 plus an explicit Other bucket retain the complete denominator. Uncoded alarms are grouped by message. Company, plant, machine, shift, dates, type, code, severity and search filters are retained. |
| PDF exports | Reports tabs, OEE Records, Machine OEE and existing dashboard exports support PDF alongside Excel and CSV. A4 portrait/landscape pages repeat headings and page numbers; long cells wrap and continue. Wide tables use column sections retaining row numbers and the first column. Embedded, openly licensed Noto Sans Tamil supports English and Tamil names. Limits of 5,000 rows / 500 pages (and 92 days for Reports tabs) refuse oversized PDFs with a clear error rather than dropping data; larger datasets can use Excel/CSV. |
| Machine health | Replaces the maintenance cycle chart with the selected machine's condition index: normal 100, warning 50, critical 0; average reported checks. Any critical check caps it at 69; an active alarm/emergency sets it to 0. Good is 70-100, Bad below 70. Missing checks and zero temperature placeholders are excluded; no evidence means unavailable. The date and stale state remain visible. This is a disclosed condition index, not a predicted failure probability or an OEM diagnostic rating. |
| Cycle chart | Moves to Production Live per-machine page, using measured running seconds / parts for each hour. Zero-output or unknown-runtime hours remain gaps. |
| Names | Preventive becomes Breakdown; Periodic becomes Schedule. Existing links, stored maintenance types and permission keys stay compatible. |
| Quality reasons | Separate optional rejection and rework reasons for each machine, shift and day, in a Reason column and the quantity editor. Existing counts are preserved. Text is limited to 500 characters; omitted fields from older clients preserve saved reasons. |

## Deployment

Deploy **migration `069_quality_reasons.sql` before the API**. It adds two nullable columns; it does not change or infer reasons for existing records. Normal migrations also include pending `068_controller_downtime_events.sql` from the earlier machine-reason fix. Apply the migration set in the approved maintenance window using the existing migration runner.

1. Install backend dependencies with `npm ci` (adds PDFKit and the bundled font).
2. Run `npm run migrate` in Backend against the intended database during approved maintenance.
3. Deploy/restart the API, then publish the FrontendIOT production build.
4. Check Quality read/edit, Reports PDF, the health score and Production Live cycle chart.

These changes do not apply migrations or delete energy history automatically. The earlier company-4 energy history cleanup remains a separate database maintenance operation.

## Verification

- Full backend regression suite, frontend targeted tests, production frontend build and five mocked Chromium acceptance flows passed during development.
- `QUALITY_TEST_DATABASE_URL=postgresql://...@127.0.0.1:PORT/postgres node scripts/verify-quality-reasons.js` verifies migration replay, preserved historical totals, independent reasons, Unicode and length limits in a disposable local database. It refuses remote URLs.
- `node scripts/validate-dashboard-data.js --env-file .env --company-id 4 --date 2026-11-24` uses PostgreSQL read-only connections, bypasses dashboard caches, and makes no model call. It compares report summaries to actual rows, checks the Pareto denominator and tests acceptance/rejection of true/fabricated figures.
- The read-only acceptance check matched production summaries to source rows and all alarm occurrences to Pareto buckets, and verified the cycle-time query against actual records. Live quality reason columns were pending when checked. Keep production acceptance snapshots outside Git.
- Multi-page PDF samples were rendered and visually inspected, including long names, Tamil text, long notes and continuation pages.

Browser acceptance command: `npx playwright test --config=playwright.enhancements.config.ts` from FrontendIOT. All API responses and WebSockets are isolated from live services in this fixture.
