const ExcelJS = require('exceljs');

/**
 * Build an XLSX attachment while retaining the report's column order and types.
 * `headerOrder`, when given, is written first even with no rows, so an empty
 * report still says what it would have held.
 */
exports.createExcel = async (sheetName, data, headerOrder = []) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  const headers = [...headerOrder];
  const seenHeaders = new Set(headers);
  for (const row of data) {
    for (const header of Object.keys(row)) {
      if (!seenHeaders.has(header)) {
        seenHeaders.add(header);
        headers.push(header);
      }
    }
  }

  if (headers.length) {
    worksheet.addRow(headers);
    for (const row of data) {
      // Strings remain literal cell values, including text beginning with '='.
      // ExcelJS only writes formulas when explicitly passed a formula object.
      // a blank is an empty cell, not an empty string a COUNTA would count
      worksheet.addRow(headers.map(header => (row[header] === '' ? null : row[header] ?? null)));
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
};
