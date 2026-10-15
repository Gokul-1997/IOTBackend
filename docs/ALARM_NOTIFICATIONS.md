# Sustained alarm notifications

The company administrator chooses which machines should notify and how long
their controller alarms must remain active. Short alarms remain in alarm
history; they do not create inbox messages unless they reach the configured
delay. This feature does not delay recording or displaying machine alarms.

## Use Settings

1. Open **Settings → Alarm notifications** as a company administrator.
2. Find the machine by its serial number or plant name.
3. Enable **Alarm alerts**, choose **30 seconds**, **1 minute**, **5 minutes**,
   **10 minutes**, or custom whole seconds, then select **Save**.
4. Keep **Receive alarm notifications** on for your own account. Other users
   who can view alarms can manage their own receive switch.

Rules start disabled. The suggested starting value is 10 minutes; choose the
delay appropriate to the machine and the action an operator should take.
Custom values range from 1 to 86,400 seconds. Enabling a rule or changing its
delay starts a new waiting period; saving identical values does not restart it.

For a 30-second rule:

| Controller observation | Inbox result |
| --- | --- |
| Alarm clears after 3 seconds | No notification |
| Alarm clears before 30 seconds | No notification |
| Fresh observations confirm the same alarm at 30 seconds | One notification becomes due |
| The same occurrence remains active | No repeated notification |
| Alarm clears, then occurs again | A new waiting period |

The server checks every 15 seconds. Delivery follows confirmation of the delay,
normally on the next check; service outages or a fleet-wide backlog can add
latency. Timers run on the server with the dashboard closed.

## Recipients and continuity

Notifications go to active users in the machine's company who have enabled
their personal alarm preference and can currently view Alarms, Alarm Report or
Live Dashboard. Both role permissions and company page grants are checked.
Plant-assigned users receive only their own plant's alerts; company
administrators can receive alerts across their company. Each link opens a page
the recipient is allowed to view. Inactive machines, companies and assigned
plants do not generate alerts. Inbox reads and read markers also require the
authenticated company, so reassigned accounts cannot access former-company
messages.

The controller clearing an alarm (`ended_at`) cancels qualification. A person's
Resolve action is acknowledgement, so it does not pretend the controller alarm
has cleared. Different reported alarm codes are separate occurrences and can
each notify once.

Duration comes from accepted device timestamps. The latest received telemetry
must still confirm the alarm, and both its device and arrival timestamps must
be fresh (within 120 seconds, with future timestamps excluded). A recorded gap
of more than 60 seconds starts qualification again at the confirmed resume.
When a collector has no trustworthy previous baseline, reconciliation also
starts a new qualification period without rewriting historical alarm start time.
Offline time is not silently used to make an old alarm become due.

Inbox insertion and the occurrence's delivered marker commit in one PostgreSQL
transaction. Row locks and a unique alarm/user index protect concurrent runs,
retries and restarts from creating duplicates. Socket unread updates follow the
commit; a socket failure leaves the inbox record available on reconnect.

The worker uses bounded batches and recent telemetry queries. Settings loads
20 machines per page, with server search and no telemetry polling. No extra MQTT
consumer, cloud service or browser timer is needed.

Web and mobile apps display these messages in their notification inbox. The
shared socket updates unread badges while connected; existing refresh paths
recover them after network interruptions. Email and background iOS/Android
push delivery are not part of this feature.

## Deployment

Back up and review the target database and pending migration status first.
Apply **047 before deploying/restarting the updated collector**:

```sh
# Backend repository, using the target server's configured database
npm run migrate -- --status
npm run migrate -- --through 047_alarm_notifications.sql
```

Then restart the API and collector with their new code, and deploy the web UI.
The production API must have scheduled jobs enabled (`CRON_ENABLED` must not be
`false`). Developer processes connected to a shared database should keep jobs
disabled. The scheduler uses a PostgreSQL advisory lock, so only one process
runs a given job at a time.

The updated collector refuses to start before the continuity column exists,
with an explicit migration 047 message. Do not bypass this guard: it prevents a
schema deployment error from being treated as a bad machine reading.

To stop new alerts, disable the machine rule in Settings. Existing alarm and
notification history remain. Rollback 047 refuses to discard saved rules or
delivery history; it is not a reset command.

## API examples

Company identity always comes from the authenticated account. Rule management
requires a company administrator with an alarm-related page grant.

```http
GET /api/alarms/notification-rules?page=1&limit=20&search=CNC
Authorization: Bearer <access-token>
```

```http
PUT /api/alarms/notification-rules/15
Authorization: Bearer <access-token>
Content-Type: application/json

{"enabled":true,"delay_seconds":30}
```

```http
PUT /api/notifications/preferences
Authorization: Bearer <access-token>
Content-Type: application/json

{"notify_alarm":true}
```

The rule list returns machine ID, serial number, plant name, enabled state and
`delay_seconds`, plus pagination. The update returns the saved rule. Personal
preference changes affect only the authenticated user. Devices continue posting
telemetry through the existing MQTT flow; they do not call notification APIs.

## Isolated verification

```sh
node tools/architecture/verify-alarm-notifications.cjs
```

This creates and removes its own private PostgreSQL cluster and verifies actual
SQL, thresholds, clear/recur, concurrency, scope, continuity, rollback and retry.
It never reads application `.env`, sends email or connects to production services.
Set `ALARM_FIXTURE_PG_BIN` to another PostgreSQL binary directory when checking
the target major version. See the project audit for the versions and checks run.
