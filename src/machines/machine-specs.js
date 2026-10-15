/**
 * A machine's specification fields — axis travel, spindle speed, model and
 * the rest — as the machine form sends them.
 *
 * The form sends "" for every box left empty. Passed through as it was, ""
 * in an integer column is a Postgres error (22P02) and the user got a 500:
 * a 3-axis machine could not be created with its 4th axis left blank
 * (15 Oct 2026; machines.fourth_axis is an integer in production). Here an
 * empty box means "not set" (null), a number field holds a whole number,
 * and anything else is a 400 the form can show.
 */
const INT_MAX = 2147483647;   // the largest Postgres integer

const WHOLE_NUMBERS = {
  x_axis: 'X axis', y_axis: 'Y axis', z_axis: 'Z axis',
  fourth_axis: '4th axis', fifth_axis: '5th axis', spindle_rpm: 'Spindle speed'
};
// ATC capacity stays free text: capacities are written like "20+1".
const TEXT = { model: 'Model', controller: 'Controller', mmc_no: 'MMC no', atc_tool_capacity: 'ATC tool capacity' };
const SWITCHES = { twin_spindle: 'Twin spindle', twin_table: 'Twin table' };

const fail = (message) => Object.assign(new Error(message), { code: 'BAD_MACHINE_SPEC', status: 400 });
const blank = (value) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

function wholeNumber(value, label) {
  if (blank(value)) return null;
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+$/.test(text) || Number(text) > INT_MAX) throw fail(`${label} must be a whole number, 0 or more.`);
  return Number(text);
}

function text(value, label) {
  if (blank(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw fail(`${label} must be text.`);
  return String(value).trim();
}

function onOff(value, label) {
  if (blank(value)) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw fail(`${label} must be on or off.`);
}

/** The spec fields `body` carries, cleaned. Fields it does not carry stay
 *  out, so an edit changes only what it sends. */
function cleanSpecs(body = {}) {
  const specs = {};
  for (const [rules, clean] of [[WHOLE_NUMBERS, wholeNumber], [TEXT, text], [SWITCHES, onOff]]) {
    for (const [key, label] of Object.entries(rules)) {
      if (body[key] !== undefined) specs[key] = clean(body[key], label);
    }
  }
  return specs;
}

module.exports = { cleanSpecs, INT_MAX };
