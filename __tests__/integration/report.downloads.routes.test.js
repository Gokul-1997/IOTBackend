/*
 * The Reports page's Excel / CSV downloads over HTTP (GET /api/reports/
 * production | hourly-oee | shift-oee).
 *
 * A small report is the file: the rows on screen — the whole date range, the
 * machine, shift and operator, the columns chosen, the order sorted. (The
 * Excel was the first day only, every machine and every column.)
 *
 * A large one is not downloaded (21 Oct 2026, the user): the answer is 202
 * and "check your email in 10–15 minutes", and the file is built after it and
 * emailed, attached, to the person's own account address. There is no Email
 * button and no way to name another recipient.
 */
process.env.REPORT_DIRECT_ROWS = '2';          // so three rows are "large"

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
app.use('/api/reports', require('../../src/reports/report.routes'));
app.use(require('../../src/middleware/error.middleware'));

const rows = list => ({ rows: list, rowCount: list.length });
const shiftRow = (machine, oee, extra = {}) => ({
  machine, operator: 'Suresh', shift: 'A', date: '21-Oct-2026',
  availability: '90.00', performance: '80.00', quality: '99.00', oee, ...extra
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
const sheetOf = async buffer => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets[0];
};

beforeEach(async () => {
  resetDb();
  sendEmail.mockClear();
  mailer._running.clear();
  mockUser = { id: 2, company_id: 5, username: 'gokul', permissions: ['page:reports:view', 'page:reports:export'] };
  await require('../../src/redis').set('company_grants:5', '[]', 'EX', 60);
});

describe('a small report downloads as the screen shows it', () => {
  test('Excel: the whole range and every filter reach the query; the chosen columns, sorted as on screen', async () => {
    mockDb.queueResponse(rows([shiftRow('CNC-01', '62.10'), shiftRow('CNC-02', '81.50')]));
    const res = await request(app)
      .get('/api/reports/shift-oee')
      .query({ date_from: '2026-10-15', date_to: '2026-10-21', machine_id: '7', shift_id: '3', operator_id: '9',
               columns: 'oee,machine', sort: 'oee', dir: 'desc' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="shift-oee_2026-10-15_to_2026-10-21.xlsx"');

    const [query] = mockDb.calls();
    expect(query.text).toMatch(/FROM oee_shift_summary/);
    expect(query.params).toEqual([5, '2026-10-15', '2026-10-21', '7', '3', '9']);

    const sheet = await sheetOf(res.body);
    expect(sheet.getRow(1).values.slice(1)).toEqual(['Machine', 'OEE %']);   // the report's order, not the request's
    expect(sheet.getRow(2).values.slice(1)).toEqual(['CNC-02', 81.5]);        // highest OEE first; a number, not "81.50"
    expect(sheet.getRow(3).values.slice(1)).toEqual(['CNC-01', 62.1]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('CSV is offered too, with the same rows and headings', async () => {
    mockDb.queueResponse(rows([shiftRow('=HYPERLINK("x")', '62.10')]));
    const res = await request(app).get('/api/reports/shift-oee')
      .query({ format: 'csv', date_from: '2026-10-21', date_to: '2026-10-21', columns: 'machine,oee' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toBe('Machine,OEE %\r\n"\'=HYPERLINK(""x"")",62.1');   // a typed formula stays text
  });

  test('the old single-day request (?date=) still downloads that day', async () => {
    mockDb.queueResponse(rows([]));
    const res = await request(app).get('/api/reports/production').query({ date: '2026-10-20' }).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(mockDb.calls()[0].params).toEqual([5, '2026-10-20', '2026-10-20', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)]);
    const sheet = await sheetOf(res.body);
    // an empty report still says what it would have held
    expect(sheet.getRow(1).values.slice(1)).toEqual(['Machine', 'Operator', 'Shift', 'Hour', 'Run Time', 'Idle Time', 'Parts Made', 'Energy (kWh)']);
  });
});

describe('what is refused before anything is read', () => {
  test.each([
    [{ date_from: '2026-10-21', date_to: '2026-10-21', format: 'pdf' }, /format must be xlsx or csv/],
    [{ date_from: '21-10-2026', date_to: '2026-10-21' }, /YYYY-MM-DD/],
    [{ date_from: '2026-10-21', date_to: '2026-10-20' }, /before/],
    [{ date_from: '2026-10-21', date_to: '2026-10-21', machine_id: '7; DROP TABLE x' }, /machine_id must be a positive whole number/],
    [{ date_from: '2026-10-21', date_to: '2026-10-21', columns: 'machine,password' }, /password/],
    [{ date_from: '2026-10-21', date_to: '2026-10-21', sort: 'password' }, /password/]
  ])('%j → 400', async (query, message) => {
    const res = await request(app).get('/api/reports/shift-oee').query(query);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('downloading needs Export', async () => {
    mockUser.permissions = ['page:reports:view'];
    const res = await request(app).get('/api/reports/shift-oee').query({ date_from: '2026-10-21', date_to: '2026-10-21' });
    expect(res.status).toBe(403);
  });

  test('there is no Email endpoint any more: nobody can send a report to an address of their choosing', async () => {
    const res = await request(app).post('/api/reports/email')
      .send({ type: 'shift-oee', date_from: '2026-10-21', date_to: '2026-10-21', email: 'someone@elsewhere.test' });
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('a large report is emailed instead', () => {
  test('more rows than a download carries: 202 "check your email", then the file is attached and sent to the account', async () => {
    mockDb.queueResponse(
      rows([shiftRow('CNC-01', '62.10'), shiftRow('CNC-02', '81.50'), shiftRow('CNC-03', '70.00')]),
      rows([{ email: 'gokul@plant.test' }]),                            // the account's own address
      rows([{ n: 2, k: 'Machine', v: 'CNC-02' }])                       // the covering note names the filter
    );
    const res = await request(app).get('/api/reports/shift-oee')
      .query({ date_from: '2026-10-15', date_to: '2026-10-21', machine_id: '7', email: 'someone@elsewhere.test' });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ queued: true, to: 'gokul@plant.test', rows: 3 });
    expect(res.body.data.message).toBe(
      'This report is large (3 rows), so it is being prepared in the background and will be emailed to gokul@plant.test. ' +
      'Please check your email in 10–15 minutes.');

    await until(() => sendEmail.mock.calls.length === 1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('gokul@plant.test');                          // never the address in the request
    expect(mail.subject).toBe('Shift OEE Report — 2026-10-15 to 2026-10-21');
    expect(mail.html).toContain('Machine: CNC-02');
    expect(mail.html).toContain('<strong>3 rows</strong>');
    expect(mail.attachments[0].filename).toBe('shift-oee_2026-10-15_to_2026-10-21.xlsx');
    const sheet = await sheetOf(mail.attachments[0].content);
    expect(sheet.rowCount).toBe(4);                                     // the heading and the three rows
  });

  test('a range past three months is read after the answer, not while the person waits', async () => {
    mockDb.queueResponse(rows([{ email: 'gokul@plant.test' }]), rows([shiftRow('CNC-01', '62.10')]));
    const res = await request(app).get('/api/reports/shift-oee').query({ format: 'csv', date_from: '2026-01-01', date_to: '2026-10-21' });
    expect(res.status).toBe(202);
    expect(res.body.data.message).toMatch(/^This report is large, so it is being prepared in the background/);

    await until(() => sendEmail.mock.calls.length === 1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.attachments[0].filename).toBe('shift-oee_2026-01-01_to_2026-10-21.csv');
    expect(mail.html).toContain('longer than three months');
    expect(mockDb.calls().map(c => c.text).findIndex(t => /oee_shift_summary/.test(t))).toBe(1);   // after the address
  });

  test('no email on the account: told so, nothing is built', async () => {
    mockDb.queueResponse(rows([{ email: null }]));
    const res = await request(app).get('/api/reports/shift-oee').query({ date_from: '2026-01-01', date_to: '2026-10-21' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_RECIPIENT');
    expect(res.body.message).toMatch(/Add your email in Account Details/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('one large report per person at a time', async () => {
    mailer._running.add(2);
    mockDb.queueResponse(rows([{ email: 'gokul@plant.test' }]));
    const res = await request(app).get('/api/reports/shift-oee').query({ date_from: '2026-01-01', date_to: '2026-10-21' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/already being prepared/);
  });

  test('if it cannot be built or sent, the person is told in the app instead of waiting', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Message size exceeds limit'));
    mockDb.queueResponse(rows([{ email: 'gokul@plant.test' }]), rows([shiftRow('CNC-01', '62.10')]));
    const res = await request(app).get('/api/reports/shift-oee').query({ date_from: '2026-01-01', date_to: '2026-10-21' });
    expect(res.status).toBe(202);

    await until(() => mockDb.calls().some(c => /INSERT INTO notifications/.test(c.text)));
    const note = mockDb.calls().find(c => /INSERT INTO notifications/.test(c.text));
    expect(note.params).toEqual([5, 2, 'Shift OEE Report was not emailed',
      'The report could not be prepared or sent. Try again, or choose fewer days or machines.', '/reports']);
    await until(() => !mailer._running.has(2));                         // free to ask again
  });
});
