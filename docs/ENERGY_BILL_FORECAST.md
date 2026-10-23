# Electricity bill forecast ("This Bill")

The Energy Dashboard shows what the current electricity bill's energy will
cost, from the dates of the bill entered on **Master → Tariff & Rates →
Electricity bill dates**.

## Setting it up

1. Tariff & Rates → **Set bill dates**: the first and the last day of the
   reading period printed on the EB bill (for example 12 Oct – 11 Nov).
   Who may: anyone with the Energy *Tariff Settings* permission
   (`page:analytics-energy:settings`) and the whole company in view.
2. The next bills follow on by themselves:
   - dates a whole number of months apart (12 Oct – 11 Nov, 1 Oct – 31 Oct,
     12 Oct – 11 Dec) repeat on the same day of the month, or on the month's
     last day when it is shorter (31 Jan → 28 Feb → 31 Mar);
   - any other length (12 Oct – 10 Nov, 30 days) repeats every that many days.
   When a reading date moves, change the dates; nothing else needs doing.
3. The tariff (₹ per kWh) is the one already on the page: each machine's own
   rate, else the company default.

## What it shows

| Figure | How it is worked out |
| --- | --- |
| Used so far | What the meters counted from the bill's first day (00:00 IST) until now, priced per machine. |
| Still to come | Each hour left in the bill at its **usual use**, priced per machine. The current hour counts for the part still left. |
| Forecast | Used so far + still to come. |
| Likely range | The rest of the bill as each of the last four weeks really was; the lowest and highest of those. |
| Last bill | The bill before this one, when the readings cover all of it. |
| Checked on the last 7 days | The method run on the last 7 days (from the weeks before them) against what the meters counted. Over 15 % off, the card says to read the forecast as a rough guide. |

**Usual use** is per machine and per hour of the week (Monday 09:00 is not
Sunday 09:00): the median of that hour over the last four weeks. A median, so
one odd week — a holiday, a breakdown, a meter offline and then catching up —
does not move it. With under a week of readings the hours of the day stand in
(no weekday pattern yet); with under a day, a machine's coming use is not
guessed and only what it counted so far is in.

Energy is measured exactly as the Energy screen measures it: differences of
consecutive real meter readings, a 0 being a dropped read, a fall a reset (no
use) and a rise faster than 2,000 kW a misread (no use).

## What it cannot know

- **Only machines with an energy meter are in it.** The EB bill also carries
  lights, compressors, air conditioning and other loads without a meter here,
  and fixed / demand charges, time-of-day rates and taxes unless they are in
  the ₹ per kWh. The card says how many machines have a meter.
- **Holidays ahead.** A shutdown coming in the rest of the bill lowers the
  real bill below the forecast; the likely range shows how low a slow week
  has gone.

## How it runs

- `energy_hourly` (migration 055) keeps kWh per machine per IST hour, worked
  out from `telemetry_raw` once and kept, so a month of history is read in
  milliseconds instead of being differenced again from compressed telemetry.
  `energy_hourly_coverage` records which hours have been worked out.
- The **energy-hourly** job (`src/cron/energyHourly.job.js`, every 10 minutes
  at :05, :15 … :55) keeps each company with meter readings in the last week up
  to the last final hour (an hour is final 15 minutes after it ends) and works
  its history back to 100 days, a week at a time, at most a minute per company
  per run. After the first deploy the history fills within a few runs.
- Reading never waits for the job: hours not kept yet (up to two days) are
  worked out from the readings on the spot. While the bill's own first days
  are not worked out yet the card says "Getting this bill's readings ready"
  and asks again by itself every 30 s.
- `energy_billing` holds each company's bill dates as entered.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/dashboard/energy/bill?machine_id=` | `page:analytics-energy:view` |
| GET | `/api/dashboard/energy/bill-period` | `page:analytics-energy:view` |
| PUT | `/api/dashboard/energy/bill-period` `{ period_start, period_end }` (YYYY-MM-DD) | `page:analytics-energy:settings` (audited) |
| DELETE | `/api/dashboard/energy/bill-period` | `page:analytics-energy:settings` (audited) |

A bill runs 7 to 93 days; its first day must be within the last year and not
more than 3 months ahead (400 otherwise). Saving or removing the dates puts
the company's cached dashboards out of date at once.

## Deploying

1. `npm run migrate` (055 adds three tables; nothing existing changes).
2. `pm2 restart iot-app --update-env` — the job starts with the API
   (not where `CRON_ENABLED=false`).
3. Set the bill dates on Tariff & Rates.

Rollback: `src/migrations/rollback/055_energy_billing_down.sql`.
