/**
 * The covering note for an emailed report.
 *
 * States what was asked for — type, range, filters, row count — because the
 * recipient may open the attachment days later, and a spreadsheet of numbers
 * with no statement of its own scope is easy to misread as "everything".
 */
module.exports = function generateReportTemplate({
  reportName, dateFrom, dateTo, rowCount, columnLabels = [], filterLines = [], requestedBy
}) {
  const filters = filterLines.length
    ? `<ul style="margin:.4rem 0 0;padding-left:1.1rem">${filterLines.map(f => `<li>${f}</li>`).join('')}</ul>`
    : '<p style="margin:.4rem 0 0;color:#64748b">No filters — every machine, shift and operator.</p>';

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2430;max-width:560px">
    <h2 style="margin:0 0 .25rem;font-size:1.15rem">${reportName}</h2>
    <p style="margin:0 0 1rem;color:#64748b;font-size:.9rem">${dateFrom} to ${dateTo}</p>

    <p style="margin:0 0 .5rem">
      Your report is attached as a spreadsheet. It covers
      <strong>${rowCount.toLocaleString('en-IN')} rows</strong>.
    </p>

    <p style="margin:1rem 0 0;font-weight:600;font-size:.9rem">Filters applied</p>
    ${filters}

    <p style="margin:1rem 0 0;font-weight:600;font-size:.9rem">Columns</p>
    <p style="margin:.4rem 0 0;color:#4b5262;font-size:.9rem">${columnLabels.join(' · ')}</p>

    <hr style="margin:1.5rem 0;border:none;border-top:1px solid #e8e9f2">
    <p style="margin:0;color:#8992a5;font-size:.8rem">
      Requested by ${requestedBy}. This report was emailed rather than downloaded
      because its date range is longer than three months.
    </p>
  </div>`;
};
