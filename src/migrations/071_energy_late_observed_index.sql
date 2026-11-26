-- migrate: statement-by-statement
-- Audit arrival can be much later than its measurement. Index the measurement
-- clock so tenant energy retention expires late packets at the right instant.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telemetry_late_company_observed_energy
 ON telemetry_late(company_id,(COALESCE(to_timestamp(device_time),received_at)))
 WHERE payload IS NOT NULL;
