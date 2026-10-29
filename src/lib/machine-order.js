/*
 * Machines in name order, the numbers in a name read as numbers (29 Oct
 * 2026, the user: one sort order for every machine list the API gives):
 * VMC - 1 - F, VMC - 2 - F … VMC - 9 - M, VMC - 10 - M, not 1, 10, 11, 2.
 *
 * The key splits a name into runs of digits and the rest; each digit run is
 * zero-padded so it compares as a number, the rest compares in lower case
 * without spaces or dashes, so "VMC-2" and "VMC - 2" sit together and
 * "VMC18- M" follows "VMC - 9 - M". Worked out in SQL, so a paged list is in
 * the same order from page to page; no schema change.
 *
 * machineOrder('m.machine_serial_no') goes in an ORDER BY; ties fall back to
 * the name itself, then to what the caller adds (an id).
 */
const naturalKey = column => `(SELECT string_agg(CASE WHEN nk.part[1] ~ '^[0-9]+$' THEN lpad(nk.part[1], 20, '0')
                ELSE lower(regexp_replace(nk.part[1], '[^[:alnum:]]', '', 'g')) END, '' ORDER BY nk.i)
           FROM regexp_matches(coalesce(${column}, ''), '[0-9]+|[^0-9]+', 'g') WITH ORDINALITY AS nk(part, i)) COLLATE "C"`;

const machineOrder = (column = 'machine_serial_no', direction = 'ASC') => {
  const dir = String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return `${naturalKey(column)} ${dir}, ${column} ${dir}`;
};

module.exports = { machineOrder, naturalKey };
