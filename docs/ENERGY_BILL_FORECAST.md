# Electricity (EB) bill forecast — "This Bill"

The Energy Dashboard forecasts the current electricity bill of each EB
service connection, worked out the way the EB bill itself is, from the bills
entered on **Master → Tariff & Rates → Electricity bills**.

## How an EB bill adds up

S AND T's bills for July–August 2026 (both add up to the rupee):

| | SC 1212 | SC 2309 |
| --- | --- | --- |
| Billing period (From → To) | 26-07-2026 → 26-08-2026 (31 days) | 26-07-2026 → 27-08-2026 (32 days) |
| Assessed units | 55,952 | 68,988 |
| Rate per unit (printed) | 8.13 | 8.25 |
| Electricity charges | 4,55,093 (= 55,952 × 8.13363 — the printed rate is rounded) | 5,69,151 (= 68,988 × 8.25) |
| Peak hour charges | 0 | – |
| Fixed charges | 91,200 | 89,984 |
| ED/LPF penalty | 16,372 (3.60 % of electricity charges) | 15,593 (2.74 %) |
| Welding surcharge | 68,264 (exactly 15 % of electricity charges) | – |
| E Tax & TCS | 29,512 (6.48 %) | 32,622 (5.73 %) |
| **Net bill** | **6,60,441** | **7,07,350** |

Net bill = electricity charges + peak hour charges + fixed charges + ED/LPF
penalty + welding surcharge + E tax & TCS (+ any other charges).

## Setting it up

1. Tariff & Rates → **Add service connection**: the number on the bill
   (1212), optionally a name, and optionally the machine record whose energy
   meter measures the whole supply (an incomer meter).
2. **Add bill**: every figure as printed. Electricity charges default to
   units × rate and the net to the sum of the charges; the form shows when the
   typed figures do not add up (a typing slip) and how far the printed rate
   is rounded.
3. Optional, for exact units: **EB meter readings** — the kWh register of the
   EB meter on a date (daily or weekly). A register only climbs; a reading out
   of order is refused.

Who may: anyone with the Energy *Tariff Settings* permission
(`page:analytics-energy:settings`) and the whole company in view. Every change
is audited. The forecast is shown to whoever sees the Energy screen and the
whole company (not to someone limited to one plant).

## How this bill is forecast

**The period.** A bill runs From its first reading To its next; the next bill
starts on that To date, so 26 Jul – 26 Aug is 31 days. After the latest bill
entered, bills follow every month (two or three for bills that long) on the
day of the month of its To date — SC 1212: 26 Sep – 26 Oct, SC 2309:
27 Sep – 27 Oct. Enter each new bill when it comes; nothing else needs doing.

**The units**, best first:

| Source | So far | Rest of the bill |
| --- | --- | --- |
| EB meter readings | latest reading − the register on the bill's From date (or between the readings either side of it, within a week) — measured | the last week of readings' units per day × the days left |
| Meter on the supply | its hours since From — measured | the median of the same hour of the week over the last 4 weeks; likely range from each of those weeks |
| The last bills (up to 3) | their units per day × the days gone — an estimate | units per day × the days left; range from bill to bill |

**The money**, as on the latest bill: electricity charges = units × the rate
it really charged (its electricity charges ÷ its units); peak hour charges,
ED/LPF penalty, welding surcharge and E tax & TCS = the same share of the
electricity charges as on that bill; fixed charges as billed. Other charges
(arrears, one-off adjustments) are not carried forward.

From the bills alone, on 23 Oct 2026: SC 1212 ≈ 54,147 units → ₹6,42,079;
SC 2309 ≈ 64,676 units → ₹6,68,764; total ₹13,10,843 (30-day bills; the
July–August bills were 31 and 32 days).

## What it cannot know

- **Penalties change.** The ED/LPF penalty follows the power factor and the
  maximum demand; the forecast assumes they stay as on the last bill.
- **Holidays ahead** lower the bill below a units-per-day forecast.
- **Estimated units** (no readings, no supply meter) are only as steady as the
  factory's use from month to month; the card says when it is an estimate.

## How it runs

- `energy_connections`, `energy_bills`, `energy_readings` (migration 056;
  056 drops 055's `energy_billing`, which was never released).
- `energy_hourly` (055) keeps kWh per machine per IST hour for a supply meter,
  filled by the **energy-hourly** job (`src/cron/energyHourly.job.js`, every 10
  minutes) back to 100 days; hours not kept yet are worked out on the spot.
- The forecast is cached per company for 30 s; any change saved through the
  API shows at once.

## API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/dashboard/energy/bill` | view |
| GET | `/api/dashboard/energy/connections` | view |
| POST / PUT / DELETE | `/api/dashboard/energy/connections[/:id]` `{ sc_number, name, meter_machine_id }` | settings, audited |
| POST / PUT / DELETE | `/api/dashboard/energy/connections/:id/bills[/:billId]` `{ from, to, units, rate, electricity_charges, peak_charges, fixed_charges, penalty_charges, welding_charges, tax_charges, other_charges, net_amount }` | settings, audited |
| POST / DELETE | `/api/dashboard/energy/connections/:id/readings[/:readingId]` `{ read_on, kwh }` | settings, audited |

A bill covers at most 3 months, its To date is after From and not in the
future, and its dates may not overlap another bill of the same supply (409).

## Deploying

1. `npm run migrate` (055, 056).
2. `pm2 restart iot-app --update-env`.
3. Enter the service connections and their latest bills on Tariff & Rates.

Rollback: `src/migrations/rollback/056_energy_connections_down.sql`, then
`055_energy_billing_down.sql`.
