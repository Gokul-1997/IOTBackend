# Ubuntu startup failures — 14 October 2026

The supplied logs show two different startup validation failures. PostgreSQL and Redis connections succeed on both servers. PM2 repeatedly spawning a process and marking it online does not establish application readiness.

| Process | Current fatal error | Meaning and correction |
| --- | --- | --- |
| `iot-app`, `/home/ubuntu/IOTBackend` | `Machine placement contains an invalid owner or status` | At least one legacy machine has an invalid company/plant ID or non-boolean active status. The former routing loader stopped the entire API. The patch excludes those machines, reports a bounded sample of IDs/reasons and allows valid companies to start. No database rows are changed or owners guessed. |
| `mqtt-ingest`, `/home/ubuntu/IOTDatabase` | `Production MQTT requires mqtts://` | Production mode rejects the configured plaintext MQTT URL, or its plaintext default when the variable is absent. Configure the actual broker's TLS listener, or the explicit loopback exception only for a broker on the same host. |

The earlier API traceback also contains `MODULE_NOT_FOUND` from `src/reports/excel.util.js`. Its first error line is absent, so the missing module's exact name is not proved by the pasted log; the source now requires ExcelJS. Install dependencies from the matching release lockfile. Later log lines reach database startup, so this is an earlier failure than the current machine-routing crash.

## API server

Deploy the local source fix with its matching `package.json`/lockfile. Use the tested Node22 runtime and make sure PM2 uses that same runtime. Then:

```sh
cd /home/ubuntu/IOTBackend
node --version
npm ci --omit=dev
pm2 restart iot-app --update-env
pm2 logs iot-app --lines 50 --nostream
curl -fsS http://127.0.0.1:8000/health/ready
```

Expected: the API listens on 8000, stops restarting and logs excluded machine IDs/reasons if legacy rows remain. Those excluded rows receive no live route. A PostgreSQL connection/query failure still prevents listening; tenant checks stay enforced.

For a read-only review of common legacy issues, use your existing PostgreSQL administration session:

```sql
SELECT id, company_id, plant_id, is_active
FROM machines
WHERE company_id IS NULL OR company_id <= 0
   OR (plant_id IS NOT NULL AND plant_id <= 0)
   OR is_active IS NULL
ORDER BY id;
```

The new warning also identifies malformed active-status types or IDs. Verify the correct company/plant/status for each row before any administration change. A NULL plant is valid for company-wide routing; it is not an invalid plant ID. Do not assign every unowned machine to company 1 or mark unknown statuses active. This patch adds no migration; the prior release still requires its reviewed migrations and recovery prerequisites.

## Collector server

The pasted logs do not disclose the actual broker hostname/port. Do not replace it with a guessed hostname.

For a broker on another host, provision/configure its TLS listener first and update the collector `.env` with the actual certificate hostname and listener port:

```dotenv
MQTT_URL=mqtts://<actual-broker-certificate-hostname>:<actual-TLS-port>
# Private CA only; omit when the certificate is publicly trusted.
MQTT_CA_FILE=/etc/iot/certs/ca.crt
```

Only for a confirmed same-host broker listening on loopback:

```dotenv
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_ALLOW_INSECURE=true
```

Keep existing credentials, stable `MQTT_CLIENT_ID` and persistent journal. The patch permits production plaintext only on `localhost`, `127.0.0.1` or `::1`; private remote IPs require TLS. PM2-provided environment values take precedence over dotenv, so resolve any conflicting PM2 values too.

Deploy the entire collector patch, including the new `server.js` and `src/lib/mqtt-config.js`, alongside `app.js`. Then:

```sh
cd /home/ubuntu/IOTDatabase
npm ci --omit=dev
pm2 restart mqtt-ingest --update-env
pm2 logs mqtt-ingest --lines 50 --nostream
curl -fsS http://127.0.0.1:9100/health
```

The supplied log uses health port 9100; use the actual `HEALTH_PORT` if changed. Confirm `mqtt connected`, `mqtt.connected: true`, a healthy writer and new telemetry/checkpoint advancement. Until connected, new readings are not being ingested; replay depends on QoS1, the persistent session and broker queue capacity. Do not delete journal/checkpoint data to resolve this configuration failure.

MQTT transport/CA validation now happens before runtime imports, Redis/database clients, writer, journal and health startup. Configuration errors therefore produce one actionable failure rather than misleading startup success messages.

## Verification scope

Backend full regression: 90 suites / 1,764 tests passed. Startup/mutation/socket focused tests: 27 passed. A disposable PostgreSQL/HTTP/Socket fixture passed with legacy unowned and unknown-status rows excluded while valid scoped routing continues. Collector: 18 suites / 337 tests passed, including 19 configuration/entry checks and real disposable Mosquitto acknowledgement/replay.

The changes are local. Neither Ubuntu server was accessed, its `.env` edited, nor its PM2 process restarted by this work.
