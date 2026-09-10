const db = require('../db');

exports.getCurrentShift = async (company_id, time) => {
  // If a full timestamp/Date is passed, extract the IST time component.
  // If a plain HH:MM:SS string is passed, cast directly.
  const timeExpr = (time instanceof Date || (typeof time === 'string' && time.length > 8))
    ? `($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::time`
    : `$2::time`;

  const { rows } = await db.query(
    `SELECT *
     FROM shifts
     WHERE company_id = $1
       AND is_active = TRUE
       AND (
         (start_time <= end_time AND ${timeExpr} BETWEEN start_time AND end_time)
         OR
         (start_time > end_time AND (${timeExpr} >= start_time OR ${timeExpr} < end_time))
       )`,
    [company_id, time]
  );
  return rows[0];
};
