/* Every format shares the filtered dataset; unsupported formats cost no query. */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const ctrl = require('../../src/dashboard/dashboard.controller');

const res = () => {
  const r = { headers: {} };
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  r.send = jest.fn(() => r);
  r.type = jest.fn(() => r);
  r.setHeader = jest.fn((k, v) => { r.headers[k] = v; return r; });
  return r;
};
const req = format => ({ params: { format }, query: {}, user: { company_id: 4 } });

const EXPORTS = ['exportEnergy', 'exportOee', 'exportOperators', 'exportDowntime', 'exportAlarms',
                 'exportPeriodic', 'exportMaintenanceReport'];

beforeEach(() => resetDb());

describe.each(EXPORTS)('%s', (name) => {
  test.each(['docx', 'zip', ''])('%p is refused, before anything is read', async (format) => {
    const r = res();
    await ctrl[name](req(format), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith({ status: 'error', message: 'format must be xlsx, csv or pdf' });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('CSV still exports (here: nothing matches, after the query)', async () => {
    const r = res();
    await ctrl[name](req('csv'), r);
    expect(mockDb.calls().length).toBeGreaterThan(0);
    expect(r.status).not.toHaveBeenCalledWith(400);
  });
});


const SERVICE = {
  exportEnergy: 'energy.service', exportOee: 'oee.dashboard.service', exportOperators: 'operator.service',
  exportDowntime: 'downtime.service', exportAlarms: 'alarm.service', exportPeriodic: 'periodic.service',
  exportMaintenanceReport: 'maintenance-report.service'
};
test.each(EXPORTS)('%s supports printable PDFs using its existing filtered export rows', async name => {
  const service = require('../../src/dashboard/' + SERVICE[name]);
  const spy = jest.spyOn(service, 'getExportRows').mockResolvedValue([{ Machine: 'VMC19', Value: 12 }]);
  try {
    const response = res();
    await ctrl[name]({ ...req('PDF'), query: { from: '2026-11-24', to: '2026-11-24', machine_id: '81' } }, response);
    expect(response.type).toHaveBeenCalledWith('application/pdf');
    expect(response.headers['Content-Disposition']).toContain('.pdf');
    expect(response.send.mock.calls[0][0].subarray(0, 5).toString()).toBe('%PDF-');
    expect(spy.mock.calls[0][0]).toMatchObject({ company_id: 4, machine_id: '81' });
  } finally { spy.mockRestore(); }
});
