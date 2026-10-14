const ExcelJS = require('exceljs');
const { createExcel } = require('../../src/reports/excel.util');

async function readExport(name, rows) {
  const buffer = await createExcel(name, rows);
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.subarray(0, 2).toString()).toBe('PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.getWorksheet(name);
}

test('real XLSX preserves report column order, values and additional row keys', async () => {
  const date = new Date('2026-10-13T00:00:00Z');
  const sheet = await readExport('Production', [
    { Machine: 'CNC-01', 'Parts Made': 0, OEE: 82.5, Active: true, Date: date },
    { Machine: 'CNC-02', 'Parts Made': 42, Note: 'தமிழ் — 工場' }
  ]);
  expect(sheet.getRow(1).values.slice(1)).toEqual(['Machine', 'Parts Made', 'OEE', 'Active', 'Date', 'Note']);
  expect(sheet.getCell('A2').value).toBe('CNC-01');
  expect(sheet.getCell('B2').value).toBe(0);
  expect(sheet.getCell('C2').value).toBe(82.5);
  expect(sheet.getCell('D2').value).toBe(true);
  expect(sheet.getCell('E2').value).toEqual(date);
  expect(sheet.getCell('B3').value).toBe(42);
  expect(sheet.getCell('C3').value).toBeNull();
  expect(sheet.getCell('F3').value).toBe('தமிழ் — 工場');
});

test('untrusted text stays literal rather than becoming a spreadsheet formula', async () => {
  const sheet = await readExport('Alarms', [
    { Machine: '=HYPERLINK("https://example.test","open")', Message: '+SUM(1,2)' },
    { Machine: '@command', Message: '-10+20' }
  ]);
  expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.String);
  expect(sheet.getCell('A2').value).toBe('=HYPERLINK("https://example.test","open")');
  expect(sheet.getCell('B2').value).toBe('+SUM(1,2)');
  expect(sheet.getCell('A3').value).toBe('@command');
  expect(sheet.getCell('B3').value).toBe('-10+20');
});

test('an empty report is still a readable workbook', async () => {
  const sheet = await readExport('Hourly OEE', []);
  expect(sheet.rowCount).toBe(0);
});
