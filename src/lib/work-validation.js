const absent = value => value === undefined || value === null || value === '';
function date(value, name, required = false) {
  if (absent(value)) {
    if (required) throw { status: 400, message: `${name} is required` };
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw { status: 400, message: `${name} must be a valid date and time` };
  return parsed;
}
function window(start, end, startName, endName) {
  const from = date(start, startName);
  const to = date(end, endName);
  if (from && to && to < from) throw { status: 400, message: `${endName} must be at or after ${startName}` };
  return { from, to };
}
function nonnegative(value, name, { integer = false } = {}) {
  if (absent(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) {
    throw { status: 400, message: `${name} must be a non-negative ${integer ? 'integer' : 'number'}` };
  }
  return n;
}
function oneOf(value, name, values, fallback) {
  const v = absent(value) ? fallback : String(value).trim().toUpperCase();
  if (!values.includes(v)) throw { status: 400, message: `${name} must be one of ${values.join(', ')}` };
  return v;
}
function title(value) {
  const t = String(value || '').trim();
  if (!t || t.length > 200) throw { status: 400, message: 'title must be 1 to 200 characters' };
  return t;
}
module.exports = { absent, date, window, nonnegative, oneOf, title };
