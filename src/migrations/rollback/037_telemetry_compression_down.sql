-- Undo 037. Decompressing needs the space back (about 20× the compressed size).
SELECT remove_compression_policy('telemetry_raw', if_exists => true);
SELECT decompress_chunk(c, true) FROM show_chunks('telemetry_raw') c;
ALTER TABLE telemetry_raw SET (timescaledb.compress = false);
DELETE FROM schema_migrations WHERE filename = '037_telemetry_compression.sql';
