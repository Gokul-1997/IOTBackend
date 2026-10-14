const ExcelJS = require('exceljs');

/** Build an XLSX attachment while retaining the report's column order and types. */
exports.createExcel = async (sheetName, data) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  const headers = [];
  const seenHeaders = new Set();
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
      worksheet.addRow(headers.map(header => row[header] ?? null));
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
};
