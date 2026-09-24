/*
 * How an alarm's severity is reported: Critical, Non-Critical or
 * Information, the three classes the agreement names for Screens 1, 2 and 3.
 *
 * This was written three times — factory, maintenance and preventive — each
 * expecting LOW / MEDIUM / HIGH / CRITICAL. The controllers in the field send
 * CRITICAL and NORMAL, so every NORMAL alarm fell through to the ELSE branch
 * and was reported as "Information": the Non-Critical figure read 0 on all
 * three screens while 850 non-critical alarms sat in the table. One
 * definition now, which reads either vocabulary.
 *
 * An unrecognised word is Non-Critical rather than Information: an alarm
 * nobody can classify is still an alarm, and filing it under "for
 * information" is how it gets ignored.
 */
const CRITICAL_WORDS = ['CRITICAL', 'FATAL', 'EMERGENCY'];
const INFO_WORDS     = ['INFO', 'INFORMATION', 'INFORMATIONAL', 'LOW', 'MESSAGE'];

const list = words => words.map(w => `'${w}'`).join(', ');

/** SQL CASE giving CRITICAL / NON_CRITICAL / INFORMATION for a severity column. */
function severityClass(column = 'severity') {
  return `
  CASE
    WHEN UPPER(${column}) IN (${list(CRITICAL_WORDS)}) THEN 'CRITICAL'
    WHEN UPPER(${column}) IN (${list(INFO_WORDS)})     THEN 'INFORMATION'
    ELSE 'NON_CRITICAL'
  END`;
}

module.exports = { severityClass, CRITICAL_WORDS, INFO_WORDS };
