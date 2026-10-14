jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const maintenance = require('../../src/maintenance/maintenance.service');
const downtime = require('../../src/downtime/downtime.service');
const tickets = require('../../src/tickets/ticket.service');
const periodic = require('../../src/maintenance/periodic-engine.service');
const pm = require('../../src/maintenance/pm-engine.service');
beforeEach(() => resetDb());
const log = { company_id: 4, machine_id: 7, title: 'Repair', started_at: '2026-10-13T08:00:00Z' };

test.each([
  { completed_at: '2026-10-12T08:00:00Z' }, { started_at: 'bad' },
  { duration_minutes: -1 }, { duration_minutes: 1.5 }, { cost: -1 }, { maintenance_type: 'UNKNOWN' }
])('invalid maintenance log %p is refused before SQL', async patch => {
  await expect(maintenance.createLog({ ...log, ...patch })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});
test('schedule linked to a log must belong to the selected machine too', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  await expect(maintenance.createLog({ ...log, maintenance_schedule_id: 5 })).rejects.toMatchObject({ status: 404 });
  expect(mockDb.calls()[0].params).toEqual([5, 4, 7]);
  expect(mockDb.calls().some(call => /INSERT/.test(call.text))).toBe(false);
});
test('duration is derived from timestamps and zero cost stays zero', async () => {
  mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
  await maintenance.createLog({ ...log, completed_at: '2026-10-13T09:30:00Z', cost: 0 });
  const params = mockDb.calls()[0].params;
  expect(params[7]).toBe(90); expect(params[11]).toBe(0);
});
test('the Maintenance form recurrence actually drives the periodic engine', async () => {
  mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
  await maintenance.createSchedule({ company_id: 4, machine_id: 7, title: 'Grease ways', scheduled_at: '2026-10-14T08:00:00Z', recurrence: 'WEEKLY', assigned_to: 'Technician Kumar' });
  const insert = mockDb.calls()[0];
  expect(insert.text).toMatch(/frequency, next_due_at/);
  expect(insert.params.slice(-2)).toEqual(['WEEKLY', new Date('2026-10-14T08:00:00Z')]);
  expect(insert.params[7]).toBe('Technician Kumar');
});
test('partial schedule edit leaves omitted fields alone', async () => {
  mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
  await maintenance.updateSchedule(1, 4, { title: 'New name' });
  const call = mockDb.calls()[0];
  expect(call.text).not.toMatch(/scheduled_at\s*=/); expect(call.params).toEqual(['New name', 1, 4]);
});
test('reversed downtime event is rejected before ownership or write', async () => {
  await expect(downtime.logEvent({ company_id: 4, machine_id: 7, started_at: '2026-10-13', ended_at: '2026-10-12' })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});
test('negative ticket downtime cannot corrupt KPIs', async () => {
  await expect(tickets.updateTicket(1, 4, { downtime_minutes: -10 })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});
test('repeating resolved status preserves original timestamps and adds no duplicate history', async () => {
  const current = { id: 1, status: 'RESOLVED', resolved_at: '2026-10-12T12:00:00Z' };
  mockDb.queueResponse({ rows: [] }, { rows: [current], rowCount: 1 }, { rows: [] });
  expect(await tickets.updateTicketStatus(1, 4, { status: 'RESOLVED', changed_by: 9 })).toEqual(current);
  expect(mockDb.calls().some(call => /^\s*(UPDATE|INSERT)\b/.test(call.text))).toBe(false);
});
test('periodic tickets receive the same durable creation history as manual tickets', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [{ id: 3, machine_id: 7, title: 'Grease', frequency: 'WEEKLY', next_due_at: '2026-10-12', assigned_user_id: 9 }] },
    { rows: [{ id: 22, status: 'ASSIGNED' }], rowCount: 1 }, { rows: [{ next: '2099-01-01' }] }, { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] });
  await periodic.evaluateCompany(4, { createdBy: 9 });
  const history = mockDb.calls().find(call => /INSERT INTO ticket_status_history/.test(call.text));
  expect(history.params).toEqual([[22], ['ASSIGNED'], 9]);
  expect(mockDb.calls().at(-1).text).toBe('COMMIT');
});
test('manual and scheduled PM runs serialize under the same company transaction lock', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [] });
  await pm.evaluateCompany(4);
  expect(mockDb.allCalls().find(call => /pg_advisory_xact_lock/.test(call.text)).params).toEqual([4]);
  const sql = mockDb.calls()[1].text;
  expect(sql).toMatch(/override.machine_id = m.id/); expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
});
