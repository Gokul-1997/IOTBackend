/*
 * Every dashboard export is Excel or CSV. The PDF exports were taken out
 * (2026-10-14) — nobody used them: asking for one, or for anything else,
 * is a 400 before anything is read. The reports PDF module is gone too.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const fs = require('fs');
const path = require('path');
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
  test.each(['pdf', 'PDF', 'docx', ''])('%p is refused, before anything is read', async (format) => {
    const r = res();
    await ctrl[name](req(format), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith({ status: 'error', message: 'format must be xlsx or csv' });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('CSV still exports (here: nothing matches, after the query)', async () => {
    const r = res();
    await ctrl[name](req('csv'), r);
    expect(mockDb.calls().length).toBeGreaterThan(0);
    expect(r.status).not.toHaveBeenCalledWith(400);
  });
});

test('no PDF anywhere: the reports PDF routes and the PDF library are gone', () => {
  const root = path.join(__dirname, '../..');
  expect(fs.readFileSync(path.join(root, 'src/routes.js'), 'utf8')).not.toMatch(/pdf/i);
  expect(fs.existsSync(path.join(root, 'src/reports/pdf.routes.js'))).toBe(false);
  expect(require(path.join(root, 'package.json')).dependencies).not.toHaveProperty('pdfkit');
  expect(require('../../src/utils/export.util')).not.toHaveProperty('tablePdf');
});
