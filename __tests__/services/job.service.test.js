/*
 * Unit tests for job.service.startJob covering the most important business
 * rules (we burned hours debugging these in prod):
 *  1. block when machine already has active job
 *  2. block when component does not belong to selected machine
 *  3. require job_start
 *  4. happy path inserts machine_current_job with component's target/part_name
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/job/job.service');

beforeEach(() => resetDb());

const fakeReq = ({ machine_id, component_id, job_start } = {}) => ({
  body: { machine_id, component_id, job_start },
  user: { company_id: 4 }
});

describe('job.service.startJob', () => {
  test('throws when job_start missing', async () => {
    await expect(svc.startJob(fakeReq({ machine_id: 1, component_id: 2 })))
      .rejects.toThrow(/job_start/);
  });

  test('blocks when machine already has an active job', async () => {
    mockDb.queueResponse({
      rows: [{ id: 99, part_name: 'OldPart' }],
      rowCount: 1
    });

    await expect(
      svc.startJob(fakeReq({ machine_id: 1, component_id: 2, job_start: '2026-04-27T08:00' }))
    ).rejects.toThrow(/already has an active job/);
  });

  test('blocks when component does not belong to selected machine', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },           // no active job
      { rows: [], rowCount: 0 }             // component not found for that machine
    );

    await expect(
      svc.startJob(fakeReq({ machine_id: 1, component_id: 99, job_start: '2026-04-27T08:00' }))
    ).rejects.toThrow(/does not belong to this machine/);
  });

  test('happy path inserts using component target/part_name', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                                         // no active job
      { rows: [{ part_name: 'PartA', target: 100 }], rowCount: 1 },      // component lookup
      { rows: [], rowCount: 1 }                                          // INSERT
    );

    await svc.startJob(fakeReq({
      machine_id: 7, component_id: 42, job_start: '2026-04-27T08:00'
    }));

    const calls = mockDb.calls();
    expect(calls).toHaveLength(3);
    expect(calls[2].text).toMatch(/INSERT INTO machine_current_job/);
    expect(calls[2].params).toEqual([4, 7, 42, 'PartA', 100, '2026-04-27T08:00']);
  });
});

describe('job.service.stopJob', () => {
  test('throws when no active job', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.stopJob(7, 4)).rejects.toThrow(/No active job/);
  });

  test('updates machine_current_job to inactive', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, part_name: 'X' }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );
    const ok = await svc.stopJob(7, 4);
    expect(ok).toBe(true);
    expect(mockDb.calls()[1].text).toMatch(/UPDATE machine_current_job/);
    expect(mockDb.calls()[1].text).toMatch(/is_active = false/);
  });
});
