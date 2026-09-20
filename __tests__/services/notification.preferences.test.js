/*
 * Per-user notification preferences.
 *
 * Distinct from alert_preferences (company-wide: whether an alarm/offline/
 * low-OEE event creates a notification at all). This is per-user: of the
 * notifications that exist, which types does this person want surfaced.
 * Created lazily on first write — a user who never opens Settings has no row
 * and getPreferences must still answer with sane defaults, not a crash.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/notifications/notification.service');

beforeEach(() => resetDb());

describe('getPreferences', () => {
  test('a user with no row yet gets the defaults, not an error', async () => {
    mockDb.queueResponse({ rows: [] });
    const prefs = await svc.getPreferences(12);
    expect(prefs).toEqual({
      notify_alarm: true, notify_maintenance: true, notify_ticket: true,
      notify_program_transfer: true, notify_system: true, email_digest: false
    });
  });

  test('an existing row is returned without its user_id or updated_at', async () => {
    mockDb.queueResponse({ rows: [{
      user_id: 12, notify_alarm: false, notify_maintenance: true,
      notify_ticket: true, notify_program_transfer: false, notify_system: true,
      email_digest: true, updated_at: '2026-09-01'
    }] });
    const prefs = await svc.getPreferences(12);
    expect(prefs.notify_alarm).toBe(false);
    expect(prefs.email_digest).toBe(true);
    expect(prefs).not.toHaveProperty('user_id');
    expect(prefs).not.toHaveProperty('updated_at');
  });
});

describe('updatePreferences', () => {
  test('rejects an update with nothing recognised to change', async () => {
    await expect(svc.updatePreferences(12, {})).rejects.toMatchObject({ status: 400 });
    await expect(svc.updatePreferences(12, { not_a_real_field: true }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('an unrecognised key is silently dropped, not written', async () => {
    mockDb.queueResponse({ rows: [{
      user_id: 12, notify_alarm: false, notify_maintenance: true, notify_ticket: true,
      notify_program_transfer: true, notify_system: true, email_digest: false
    }] });
    await svc.updatePreferences(12, { notify_alarm: false, is_admin: true });
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).not.toMatch(/is_admin/);
    expect(params).toEqual([12, false]);
  });

  test('upserts on first write — insert with the user_id, update on conflict', async () => {
    mockDb.queueResponse({ rows: [{
      user_id: 12, notify_alarm: true, notify_maintenance: false, notify_ticket: true,
      notify_program_transfer: true, notify_system: true, email_digest: false
    }] });
    const out = await svc.updatePreferences(12, { notify_maintenance: false });
    expect(out.notify_maintenance).toBe(false);
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).toMatch(/INSERT INTO notification_preferences/);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(params).toEqual([12, false]);
  });

  test('several fields update together in one statement', async () => {
    mockDb.queueResponse({ rows: [{
      user_id: 12, notify_alarm: false, notify_maintenance: false, notify_ticket: true,
      notify_program_transfer: true, notify_system: true, email_digest: true
    }] });
    await svc.updatePreferences(12, { notify_alarm: false, notify_maintenance: false, email_digest: true });
    const { params } = mockDb.calls()[0];
    expect(params).toEqual([12, false, false, true]);
  });

  test('a falsy value is written as false, not skipped as absent', async () => {
    mockDb.queueResponse({ rows: [{
      user_id: 12, notify_alarm: false, notify_maintenance: true, notify_ticket: true,
      notify_program_transfer: true, notify_system: true, email_digest: false
    }] });
    await svc.updatePreferences(12, { notify_alarm: false });
    const { params } = mockDb.calls()[0];
    expect(params).toEqual([12, false]);
  });
});
