# Sparse energy observations — 29 October 2026

Separate electrical publications on the existing machine topic are persisted independently from CNC status. The collector accepts individual PowerData fields and EnergyFormatted/EnergyData.Total_kWh aliases, with receipt-time fallback only for timestamp-free energy packets.

Migration 063 adds standalone/source-field metadata to the existing typed meter table, a partial tenant/machine/time index, limited measurement UPDATE privileges and the canonical energy_observations view. The view suppresses duplicate scalar measurements from full telemetry at the same device second, preserves other raw fields, and exposes observation time separately from receipt time. It does not rewrite history.

Energy dashboard/export and machine detail use that source. Calculations use observation ordering with bounded receipt-time scans. Latest meter and maintenance supply readings merge channels independently with their real timestamps and stale flags. Unknown usage stays null; reset and impossible steps do not become consumption. The web meter panel distinguishes mixed old/new channels.

The collector's source-field merge also prevents a delayed full payload in the same device second from lowering a newer independent counter. CNC status, alarms, runtime, parts and liveness remain on the existing full-message flow. No extra mobile API is introduced.

Firmware examples, required heartbeat for exact hourly allocation, timestamp/replay limits and deployment order are in pms-backend/docs/PARTIAL_ENERGY_MESSAGES.md.

Validation includes the complete collector/backend regression suites, meter-panel tests and production frontend build; real PostgreSQL execution of migrations and INSERT/UPDATE permissions, sparse same-second fields, source precedence, duplicate-source suppression, latest field timestamps, delayed full observation ordering and reset sequence 500 → 520 → 3 → 5 (22 kWh). Production payloads were not fabricated or inserted for testing.
