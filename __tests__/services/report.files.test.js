/*
 * The pieces every Reports download and emailed report is made of: the CSV
 * writer, the column shaping and sorting, and the covering note.
 */
const { toCsv } = require('../../src/utils/export.util');
const { resolveColumns, shapeRows, sortRows } = require('../../src/reports/report.columns');
const note = require('../../src/utils/nodemailer/emailTemplates/generateReportTemplate');

describe('CSV', () => {
  test('a typed formula opens as text, not as a formula ("CSV injection")', () => {
    const csv = toCsv([
      { Machine: '=HYPERLINK("https://x.test","open")' }, { Machine: '+SUM(1,2)' }, { Machine: '@cmd' },
      { Machine: '-10+20' }, { Machine: '\tTAB' }
    ]);
    expect(csv.split('\r\n')).toEqual([
      'Machine', '"\'=HYPERLINK(""https://x.test"",""open"")"', '"\'+SUM(1,2)"', "'@cmd", "'-10+20", "'\tTAB"
    ]);
  });

  test('a number stays a number, a minus sign included', () => {
    expect(toCsv([{ a: -5, b: '-12.5', c: '+3', d: 0 }])).toBe('a,b,c,d\r\n-5,-12.5,+3,0');
  });

  test('the report\'s headings come first even with no rows', () => {
    expect(toCsv([], ['Date', 'Machine'])).toBe('Date,Machine');
    expect(toCsv([])).toBe('');
  });

  test('a heading is quoted like any other cell', () => {
    expect(toCsv([{ 'Energy, kWh': 1 }])).toBe('"Energy, kWh"\r\n1');
  });
});

describe('columns', () => {
  test('a numeric column becomes a number, so a spreadsheet can sum it', () => {
    const cols = resolveColumns('shift-oee', ['machine', 'oee']);
    expect(shapeRows([{ machine: 'CNC-01', oee: '81.50' }, { machine: 'CNC-02', oee: null }], cols))
      .toEqual([{ Machine: 'CNC-01', 'OEE %': 81.5 }, { Machine: 'CNC-02', 'OEE %': '' }]);
  });

  test('text that only looks numeric in a text column stays as typed', () => {
    const cols = resolveColumns('shift-oee', ['machine']);
    expect(shapeRows([{ machine: '007' }], cols)).toEqual([{ Machine: '007' }]);
  });

  test('sorting is the screen\'s: numbers as numbers, text as text, either way', () => {
    const data = [{ machine: 'B', oee: '9.5' }, { machine: 'a', oee: '81.5' }, { machine: 'C', oee: '10' }];
    expect(sortRows(data, 'shift-oee', 'oee', 'desc').map(r => r.oee)).toEqual(['81.5', '10', '9.5']);
    expect(sortRows(data, 'shift-oee', 'machine', 'asc').map(r => r.machine)).toEqual(['a', 'B', 'C']);
    expect(sortRows(data, 'shift-oee', undefined)).toBe(data);            // no column: the report's order
  });

  test('sorting by something that is not a column is refused', () => {
    expect(() => sortRows([], 'shift-oee', 'password')).toThrow(/password/);
  });
});

describe('the covering note', () => {
  test('names typed by people are escaped, never run as HTML', () => {
    const html = note({
      reportName: 'OEE Records', dateFrom: '2026-10-01', dateTo: '2026-10-21', rowCount: 25000,
      columnLabels: ['Machine'], filterLines: ['Machine: <img src=x onerror=alert(1)>'], requestedBy: '<b>x</b>'
    });
    expect(html).toContain('Machine: &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Requested by &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('25,000 rows');
  });

  test('says why it came by email', () => {
    expect(note({ rowCount: 1, reason: 'rows' })).toContain('because it is too large to download');
    expect(note({ rowCount: 1, reason: 'range' })).toContain('because its date range is longer than three months');
  });
});
