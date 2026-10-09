/*
 * Dashboards with charts and tables show them on separate tabs in the web
 * app (Charts | …Details), under the KPI tiles every tab shares. The API
 * serves each in its own part, `?part=` one or more of:
 *
 *   kpis    the tiles above the tabs, and the filter lists that come with them
 *   charts  what the Charts tab draws
 *   table   what the tables tab lists
 *
 * so a page asks only for what is on screen and out of date: opening the
 * tables tab asks for `table` alone, and so does paging or sorting it; a
 * filter change there asks for `kpis,table` — never the charts.
 *
 * No `part` (or `part=all`) is everything in one answer, as before: the
 * exports and any older client are unchanged.
 */
const PARTS = ['kpis', 'charts', 'table'];

function parsePart(value) {
  if (value === undefined || value === null || value === '' || value === 'all') {
    return { kpis: true, charts: true, table: true, all: true };
  }
  // ?part=kpis,table — or ?part=kpis&part=table, which Express hands over as an array
  const list = String(value).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || list.some(p => !PARTS.includes(p))) {
    throw Object.assign(new Error(`part must be one or more of ${PARTS.join(', ')}`), { status: 400 });
  }
  const want = { kpis: false, charts: false, table: false, all: false };
  for (const p of list) want[p] = true;
  want.all = PARTS.every(p => want[p]);
  return want;
}

/** Run a query only for a part that was asked for; otherwise nothing, at no cost. */
function when(wanted, run, otherwise = null) {
  return wanted ? run() : Promise.resolve(otherwise);
}

module.exports = { parsePart, when, PARTS };
