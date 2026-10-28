# Fanuc battery diagnostics — 28 October 2026

This implements the embedded team's `acc_battery` and `cnc_battery_warning` contract in the existing Maintenance Dashboard and Alarms flow. Battery warnings are independent of energy measurements and machine RUNNING/IDLE/breakdown state.

## Payload contract

Machine eligibility comes from the configured `machines.controller_type = FANUC`. A payload cannot grant itself Fanuc support. Configure the controller type in the machine form; unsupported or unknown makes do not receive these new battery features.

```json
{
  "acc_battery": {
    "X": { "low": false, "raw": 0, "ABP": false, "INP": false, "EXP": false },
    "A": { "low": true, "raw": 32, "ABP": false, "INP": false, "EXP": true }
  },
  "cnc_battery_warning": { "warning": true, "raw_alarm_value": 1 }
}
```

Axes are dynamic, including X/Y/Z/A/B. At most 16 unique valid axis names are accepted. Optional `status` and `source` metadata is bounded to 64 and 160 characters respectively. These strings do not determine warning state.

| Diagnostic | Supplied bit mapping | Meaning when active |
|---|---|---|
| ABP | #3 (8) | A/B phase detector battery voltage low |
| INP | #4 (16) | Built-in serial pulse coder battery low |
| EXP | #5 (32) | Separate/external serial detector battery low |

The bit mapping is the embedded-team contract supplied for these Fanuc controllers. Explicit flags and valid raw bits are combined conservatively: positive evidence takes precedence over a contradictory false flag. A valid clear aggregate or clear raw bits means no warning was reported. Missing or invalid values remain unknown.

CNC `warning` is separate from ACC detector diagnostics. `raw_alarm_value` is a general CNC alarm field and is retained as metadata; it cannot establish a battery warning by itself. For example, a raw value of 1 with no `warning` flag remains unknown. `warning: false` is a reported clear state, not a voltage reading or proof that every battery is healthy.

## Storage and API

Migration 062 adds two nullable JSONB columns to `telemetry_raw`:

- `acc_battery_status`: normalized per-axis low/ABP/INP/EXP flags, raw diagnostic and optional metadata.
- `cnc_battery_warning`: normalized warning flag, raw general alarm value and optional metadata.

The older `apc_battery_status` field remains compatible. Fresh valid ACC aggregate flags also populate that legacy flat axis map. Historical readings are not inferred or backfilled. The collector writes diagnostics in its existing durable journal/telemetry transaction; no battery query runs for every packet. Cold recovery reads existing open battery codes once with the machine baseline.

The maintenance API returns `controller_type`, `battery_supported` and both diagnostic fields. The new fields are unavailable for non-Fanuc machines. Company, plant, current machine ownership, active state and observation-time boundaries remain enforced. Before 062 is installed, optional-column fallback leaves the older APC readings usable.

## Display and warning lifecycle

The Maintenance Dashboard retains its existing layout and shows a Fanuc CNC warning card and an ACC axis card. Active warnings read **Check battery** and identify the axis and ABP/INP/EXP flag. False reads **No warning reported**; unknown reads **Not reported**. The icons do not claim charge percentage or battery voltage. Changing a machine/filter or receiving a failed new selection cannot display old battery values under that selection.

Warnings use the existing tenant-scoped `machine_alarms` history with application-generated codes:

- `FANUC_CNC_BATTERY`
- `FANUC_ACC_<AXIS>_ABP`, `_INP`, `_EXP`
- `FANUC_ACC_<AXIS>_LOW` when only an aggregate low flag is available.

These are noncritical maintenance warnings, not hardware alarm numbers. They do not turn a cutting machine into a breakdown or add downtime. Repeated observations do not reopen the same warning. Explicit clear evidence ends that warning; a missing axis or missing packet field does not resolve it. Cold restart/reconciliation also preserves unknown battery warnings. Existing critical notification policy is unchanged; no new external-message channel is enabled.

## Release order

1. Verify the intended database and existing migration ledger. Apply migration 062 before the updated collector starts. It only adds nullable columns, uses a five-second lock timeout and rewrites no telemetry rows. A lock timeout rolls back safely; retry in a quiet window.
2. Deploy/restart the collector. Its startup schema check must pass; confirm journal writes resume and new readings populate the new fields.
3. Deploy the API and frontend. Select a configured Fanuc machine on Maintenance Dashboard and verify clear, active and missing diagnostic cases.
4. Check normal Alarms history for the application-generated warning code, and confirm the machine remains RUNNING when it is still cutting.

Use the versioned migration runner for an installation whose ledger has been verified. Do not mark an unapplied migration as baselined. To roll back, stop/downgrade the new collector before dropping 062 columns; drain compatible pending journal work first. The rollback file retains the older APC column and drops only the new diagnostic history.

No production migration or historical rewrite was performed during implementation. Test results and release commits are recorded with the delivery.

## Verification

- Backend: 2463 tests across 128 suites passed.
- Collector: 494 tests across 25 suites passed, including the migration 062 startup guard and JSONB-safe Unicode metadata handling.
- Frontend: 395 tests across 49 files passed, plus 72 local mocked Maintenance browser/layout checks, including 360px phone layout and changed-machine failure handling. Production build passed with existing bundle/style budget warnings.
- Disposable PostgreSQL: 34 migration/API checks, including idempotence, rollback, legacy-column compatibility, company/plant isolation and lock-timeout retry.
- A further 30 end-to-end checks passed through the real collector parser, journal record, typed SQL insert and alarm transition writer. These covered the supplied counter/power fields, extra axes, contradictory flags, explicit clearing, missing readings, cold restart and separate companies.

No configured production services were used for these checks.
