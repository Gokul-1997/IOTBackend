# Critical alarm notifications

This phase sends **critical alarm notifications only**. Normal and informational
alarms continue to appear in alarm history without creating inbox messages.
Advanced rules, configurable delays and machine exceptions are deferred.

## Settings

1. A company administrator opens **Settings → Alarm notifications**.
2. Enable **Critical alarm alerts** for the company and save. This applies to all
   active machines, including newly added machines.
3. Each recipient keeps their personal **Receive alarm notifications** switch on.

The company setting starts disabled until explicitly saved. A suggested switch
state is not activation. Existing per-machine delay records from migration 047
remain preserved but do not control this phase. Their old rules do not silently
activate company-wide critical alerts. Reload a conflicting version before
replacing another administrator's saved setting.

Critical alarms notify without an intentional waiting period. There is no delay
editor, normal/information delivery control or machine exception screen in this
phase. Turning the company switch off stops new delivery; existing history stays.

Priority comes from accepted controller telemetry, not message-text guesses.
Case and surrounding spaces are normalized: `CRITICAL`, `FATAL` and `EMERGENCY`
are critical. Other values do not notify. Verify the device adapter reports the
intended severity; the existing FOCAS adapter can also infer critical priority
from supported controller alarm types and emergency-stop signals.

| Controller observations | Result when company alerts are enabled |
| --- | --- |
| A normal or information alarm occurs | History only |
| A critical alarm clears after three seconds | One notification from its committed event, even if already cleared when processed |
| The same alarm code changes from normal to critical | One critical notification |
| The same physical occurrence reports critical repeatedly | No repeat notification |
| An alarm clears and later occurs again as critical | A new notification |
| Company alerts are enabled while a critical alarm is active | A fresh confirming observation can qualify it |

## Delivery and access

PMS writes critical events to `alarm_notification_events` in the same PostgreSQL
transaction as accepted telemetry and the journal checkpoint. Unchanged readings
do not create repeated events. Transactional `NOTIFY` wakes a dedicated API
`LISTEN` connection after commit. A bounded worker drains the durable outbox.
A 15-second recovery scan handles missed wakeups and confirms currently active
critical alarms after activation. Listener reconnects do not discard queued work.

Immediate delivery is event driven, not a hard real-time safety guarantee.
Database outages, collector disconnects and queued work can add latency. Events
and confirming observations must be fresh; historical replay, future timestamps
and offline time do not generate a flood of alerts. Events must also follow the
company's activation boundary. A resolved controller occurrence does not qualify
as a new active alarm when settings are enabled.

Inbox insertion and the occurrence's critical-delivery marker commit together.
Row locks and a unique index protect retries and concurrent workers. Socket
unread updates follow commit. Socket failure leaves the inbox message available
on reconnect. Processed transport events expire in bounded cleanup batches after
seven days; machine alarm and inbox history remain.

Recipients must be active users in the machine's company, have their personal
alarm preference enabled and currently have access to Alarms, Alarm Report or
Live Dashboard. Role permissions and company grants must agree. Plant-assigned
users receive their plant's alerts; company administrators can receive company-wide
alerts. Links open an allowed page. Inactive companies, machines and assigned
plants do not notify. Inbox reads and read markers also bind the authenticated
company, protecting account reassignment.

Web and mobile inboxes use the existing notification API and unread socket.
Email and native background iOS/Android push are not connected by this feature.
No new cloud service, MQTT consumer or frontend polling timer is needed.

## Deployment

Back up and review target migration status. Apply **047 and 048 before restarting
the updated collector**, using the target server's configured database:

```sh
npm run migrate -- --status
npm run migrate -- --through 048_alarm_notification_policies.sql
```

Then deploy/restart the API and collector, and deploy the web UI. The collector
checks required schema before admission; do not bypass this guard. Keep scheduled
delivery enabled on the server (`CRON_ENABLED` must not be `false`). Developer
processes connected to shared databases must keep it off; the listener is also
disabled in those processes. Include the listener's one held connection in API
pool sizing. The scheduler uses PostgreSQL advisory locks.

Migration 048 conditionally grants the existing `machine_api_user` collector role
SELECT/INSERT on the outbox and USAGE on its sequence. A different collector role
needs equivalent narrow grants before restart. Existing alarm-table read/write
privileges remain necessary. Guarded rollbacks refuse to discard saved settings
or delivery history. Migration 047 remains unchanged for deployed installations.

## API examples

Company identity comes from the authenticated account. Company settings require
a company administrator with an alarm-related page grant.

```http
GET /api/alarms/notification-policy
Authorization: Bearer <access-token>
```

Use the returned version when saving (`0` if unconfigured):

```http
PUT /api/alarms/notification-policy
Authorization: Bearer <access-token>
Content-Type: application/json

{"enabled":true,"expected_version":0}
```

Stale versions return HTTP 409. Personal changes affect only the signed-in user:

```http
PUT /api/notifications/preferences
Authorization: Bearer <access-token>
Content-Type: application/json

{"notify_alarm":true}
```

The retired per-machine delay-rule endpoints return HTTP 410 with guidance to
use company critical alert settings. Deploy the matching frontend with the API.
Devices continue publishing accepted telemetry through MQTT; they do not call
notification settings APIs.

## Isolated verification

```sh
node tools/architecture/verify-alarm-notifications.cjs
```

This creates and removes a private PostgreSQL cluster and exercises real SQL.
It never reads application `.env`, sends email or connects to production services.
Set `ALARM_FIXTURE_PG_BIN` to a target PostgreSQL binary directory when checking
another major version. See the project audit for executed checks.
