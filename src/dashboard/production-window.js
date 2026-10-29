/* A report date names the day a shift STARTS, including its overnight tail.
   Hourly rows can begin before a half-hour shift starts, so compare their
   overlap rather than dropping that first bucket. Keep the scan bounded and
   reject future buckets even if a device has written ahead of the clock. */
const ZONE = "'Asia/Kolkata'";

function shiftDateWindow(row, shift, { from = '$2::date', to = '$3::date', asOf = 'NOW()' } = {}) {
  return `${row}.hour_start >= ((${from})::timestamp AT TIME ZONE ${ZONE}) - INTERVAL '1 hour'
      AND ${row}.hour_start < LEAST((((${to}) + 2)::timestamp AT TIME ZONE ${ZONE}), ${asOf})
      AND (
        (${shift}.start_time IS NULL
          AND ${row}.hour_start >= (${from})::timestamp AT TIME ZONE ${ZONE}
          AND ${row}.hour_start < ((${to}) + 1)::timestamp AT TIME ZONE ${ZONE})
        OR (${shift}.start_time IS NOT NULL
          AND ${row}.hour_start + INTERVAL '1 hour' > ((${from}) + ${shift}.start_time) AT TIME ZONE ${ZONE}
          AND ${row}.hour_start < (CASE WHEN ${shift}.start_time >= ${shift}.end_time
              THEN ((${to}) + INTERVAL '1 day' + ${shift}.end_time)
              ELSE ((${to}) + ${shift}.end_time) END) AT TIME ZONE ${ZONE}
          AND ((((${asOf}) AT TIME ZONE ${ZONE})::date + ${shift}.start_time) AT TIME ZONE ${ZONE} <= ${asOf}
            OR ${row}.hour_start + INTERVAL '1 hour' <=
              ((((${asOf}) AT TIME ZONE ${ZONE})::date + ${shift}.start_time) AT TIME ZONE ${ZONE}))
        )
      )`;
}

/* Use the END of the hour to recognise a shift's first partial bucket.
   e.g. the 20:00 bucket of a 20:30 overnight shift belongs to today's shift. */
function shiftStartDay(row, shift) {
  const localEnd = `((${row}.hour_start + INTERVAL '1 hour' - INTERVAL '1 microsecond') AT TIME ZONE ${ZONE})`;
  return `(${localEnd}::date - CASE WHEN ${shift}.start_time >= ${shift}.end_time
    AND ${localEnd}::time < ${shift}.start_time THEN 1 ELSE 0 END)`;
}

module.exports = { shiftDateWindow, shiftStartDay };
