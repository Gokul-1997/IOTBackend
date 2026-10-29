/*
 * OEE Records — the Reports page's OEE Records tab (GET /api/oee/reports and
 * GET /api/oee/export), 21 Oct 2026: "OEE Records looks and exports
 * differently from the other tabs".
 *
 *  - Its rows are Shift OEE's rows: the same summary table, the same
 *    operator rule, figures to two places, a date with no time zone in it.
 *  - Sorting by Shift sorts by shift (it sorted by date), unknown figures
 *    last either way, and a page never repeats or skips a row.
 *  - It exports CSV and Excel, every record for the filters (not one page),
 *    in the table's columns under its headings and in its order.
 *  - A large export is emailed instead, as on every Reports tab.
 */
process.env.REPORT_DIRECT_ROWS = '2';

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/nodemailer', () => ({ sendEmail: jest.fn(async () => '250 OK') }));
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Sign in required' });
  req.user = mockUser;
  next();
});

const express = require('express');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { sendEmail } = require('../../src/utils/nodemailer');
const mailer = require('../../src/reports/report.mailer');

const app = express();
app.use(express.json());
app.use('/api/oee', require('../../src/oee/oee.routes'));
app.use(require('../../src/middleware/error.middleware'));

const rows = list => ({ rows: list, rowCount: list.length });
const record = (machine, extra = {}) => ({
  shift_date: '2026-10-21', machine_id: 1, machine_serial_no: machine, shift_code: 'A', shift_name: 'Morning',
  operator_name: 'Suresh', oee: '74.10', availability: '100.00', performance: '74.10', quality: '100.00', ...extra
});
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
};
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const RANGE = { from_date: '2026-10-15', to_date: '2026-10-21' };

beforeEach(async () => {
  resetDb();
  sendEmail.mockClear();
  mailer._running.clear();
  mockUser = { id: 2, company_id: 5, username: 'gokul', permissions: ['page:oee-reports:view', 'page:oee-reports:export'] };
  await require('../../src/redis').set('company_grants:5', '[]', 'EX', 60);
});

describe('the page of records', () => {
  test('the same rows as Shift OEE: its operator rule, 2 places, the date as YYYY-MM-DD', async () => {
    mockDb.queueResponse(rows([{ total: '1' }]), rows([record('VMC-1')]));
    const res = await request(app).get('/api/oee/reports').query({ ...RANGE, page: 1, limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'success', data: [record('VMC-1')], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } });

    const sql = mockDb.calls()[1].text;
    expect(sql).toMatch(/DISTINCT ON \(oma\.machine_id\)[\s\S]*ORDER BY oma\.machine_id, oma\.id DESC/);   // operator-map.js
    expect(sql).toMatch(/JOIN operators o ON o\.id = oma\.operator_id AND o\.is_active = TRUE/);
    expect(sql).toMatch(/TO_CHAR\(os\.shift_date, 'YYYY-MM-DD'\)\s+AS shift_date/);
    expect(sql).toMatch(/ROUND\(os\.oee::numeric, 2\)/);
  });

  test('filters are bound, never written into the SQL; the company always comes first', async () => {
    mockDb.queueResponse(rows([{ total: '0' }]), rows([]));
    await request(app).get('/api/oee/reports').query({ ...RANGE, line_id: '3', machine_id: '7', shift_id: '9', page: 2, limit: 15 });
    const [count, page] = mockDb.calls();
    expect(count.params).toEqual([5, 3, 7, 9, '2026-10-15', '2026-10-21']);
    expect(count.text).toContain('m.company_id = $1');
    expect(count.text).toContain('s.company_id = $1');
    expect(count.text).toContain("AT TIME ZONE 'Asia/Kolkata' <= NOW()");
    expect(count.text).toMatch(/m\.line_id = \$2 AND os\.machine_id = \$3 AND os\.shift_id = \$4 AND os\.shift_date BETWEEN \$5::date AND \$6::date/);
    expect(page.params).toEqual([5, 3, 7, 9, '2026-10-15', '2026-10-21', 15, 15]);   // limit, offset
  });

  test.each([
    ['shift_code', 'ASC', 's.shift_code ASC NULLS LAST'],
    ['oee', 'DESC', 'os.oee DESC NULLS LAST'],
    ['machine_serial_no', 'ASC', 'm.machine_serial_no ASC NULLS LAST'],
    ['__proto__', 'ASC', 'os.shift_date ASC NULLS LAST'],
    ['oee; DROP TABLE x', 'DESC', 'os.shift_date DESC NULLS LAST']
  ])('sort_by=%s %s → ORDER BY %s, then a fixed order', async (sort_by, sort_order, first) => {
    mockDb.queueResponse(rows([{ total: '0' }]), rows([]));
    await request(app).get('/api/oee/reports').query({ ...RANGE, sort_by, sort_order });
    const sql = mockDb.calls()[1].text;
    expect(sql).toContain(`ORDER BY ${first}, os.shift_date DESC, m.machine_serial_no ASC, s.start_time ASC, os.machine_id, os.shift_id`);
    expect(sql).not.toMatch(/DROP TABLE/);
  });

  test('a page holds at most 100 records', async () => {
    mockDb.queueResponse(rows([{ total: '0' }]), rows([]));
    await request(app).get('/api/oee/reports').query({ ...RANGE, limit: 5000 });
    expect(mockDb.calls()[1].params.slice(-2)).toEqual([100, 0]);
  });

  test.each([
    [{ from_date: '2026-10-21', to_date: '2026-10-20' }, 'INVALID_RANGE'],
    [{ from_date: '2026-02-30', to_date: '2026-03-01' }, 'INVALID_DATE'],
    [{ ...RANGE, machine_id: 'abc' }, 'INVALID_FILTER']
  ])('%j is refused (400 %s), not handed to SQL', async (query, code) => {
    const res = await request(app).get('/api/oee/reports').query(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('the file', () => {
  test('Excel: every record, the table\'s headings, figures as numbers, a readable date, "--" for no operator', async () => {
    mockDb.queueResponse(rows([record('VMC-1'), record('VMC-2', { operator_name: null, oee: null, performance: null })]));
    const res = await request(app).get('/api/oee/export').query({ ...RANGE, format: 'xlsx', sort_by: 'oee', sort_order: 'DESC' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="oee-records_2026-10-15_to_2026-10-21.xlsx"');
    const [query] = mockDb.calls();
    expect(query.text).toContain('ORDER BY os.oee DESC NULLS LAST');      // the table's order
    expect(query.params.at(-1)).toBe(3);                                   // a download's rows, and one more to tell

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.worksheets[0];
    expect(sheet.getRow(1).values.slice(1)).toEqual(
      ['Date', 'Machine', 'Shift', 'Operator', 'OEE (%)', 'Availability (%)', 'Performance (%)', 'Quality (%)']);
    expect(sheet.getRow(2).values.slice(1)).toEqual(['21-Oct-2026', 'VMC-1', 'A', 'Suresh', 74.1, 100, 74.1, 100]);
    expect(sheet.getCell('D3').value).toBe('--');
    expect(sheet.getCell('E3').value).toBeNull();                         // unknown is blank, not 0
  });

  test('CSV with only the columns the person can see', async () => {
    mockDb.queueResponse(rows([record('VMC-1')]));
    const res = await request(app).get('/api/oee/export').query({ ...RANGE, format: 'csv', columns: 'shift_date,machine_serial_no,oee' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toBe('Date,Machine,OEE (%)\r\n21-Oct-2026,VMC-1,74.1');
  });

  test('no format is CSV, as the old button asked', async () => {
    mockDb.queueResponse(rows([record('VMC-1')]));
    const res = await request(app).get('/api/oee/export').query(RANGE);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('nothing to export: 404 with a sentence, not an empty file', async () => {
    mockDb.queueResponse(rows([]));
    const res = await request(app).get('/api/oee/export').query({ ...RANGE, format: 'xlsx' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No OEE records match these filters');
  });

  test.each([
    [{ ...RANGE, format: 'pdf' }, 400, /format must be xlsx or csv/],
    [{ format: 'csv' }, 400, /from_date must be a date/],
    [{ ...RANGE, columns: 'oee,password' }, 400, /password/],
    [{ from_date: '2025-01-01', to_date: '2026-10-21' }, 413, /Up to 366 days/]
  ])('%j → %i', async (query, status, message) => {
    const res = await request(app).get('/api/oee/export').query(query);
    expect(res.status).toBe(status);
    expect(res.body.message).toMatch(message);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('exporting needs Export on OEE Records', async () => {
    mockUser.permissions = ['page:oee-reports:view'];
    const res = await request(app).get('/api/oee/export').query({ ...RANGE, format: 'xlsx' });
    expect(res.status).toBe(403);
  });
});

describe('a large export is emailed instead', () => {
  test('202 "check your email", then every record is read, attached and sent to the account', async () => {
    mockDb.queueResponse(
      rows([record('VMC-1'), record('VMC-2'), record('VMC-3')]),      // more than a download carries
      rows([{ total: '3' }]),
      rows([{ email: 'gokul@plant.test' }]),
      rows([{ n: 1, k: 'Line', v: 'Bay 1' }]),
      rows([record('VMC-1'), record('VMC-2'), record('VMC-3')])       // read again, all of it, after the answer
    );
    const res = await request(app).get('/api/oee/export').query({ ...RANGE, format: 'xlsx', line_id: '3' });
    expect(res.status).toBe(202);
    expect(res.body.data.message).toBe(
      'This report is large (3 rows), so it is being prepared in the background and will be emailed to gokul@plant.test. ' +
      'Please check your email in 10–15 minutes.');

    await until(() => sendEmail.mock.calls.length === 1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('gokul@plant.test');
    expect(mail.subject).toBe('OEE Records — 2026-10-15 to 2026-10-21');
    expect(mail.html).toContain('Line: Bay 1');
    expect(mail.attachments[0].filename).toBe('oee-records_2026-10-15_to_2026-10-21.xlsx');
    expect(mockDb.calls().at(-1).params.at(-1)).toBe(250001);             // the background read has its own ceiling
  });
});
