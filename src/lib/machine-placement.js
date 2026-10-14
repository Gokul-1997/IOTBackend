/* Authoritative routing for the current single API process. Collector metadata
 * may be cached; it must never decide which plant receives live readings.
 * Initialize before listening, then refresh only after application mutations.
 * Multi-process APIs or out-of-band SQL changes require a shared invalidation
 * protocol before they can safely use this in-process cache.
 */
let ready = false;
let placements = new Map();
const writes = new Map();

function positiveId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function canonical(row) {
  const id = positiveId(row?.id);
  const companyId = positiveId(row?.company_id);
  const plantId = row?.plant_id == null ? null : positiveId(row.plant_id);
  if (!id || !companyId || (row.plant_id != null && !plantId) || typeof row.is_active !== 'boolean') return null;
  return Object.freeze({ id, company_id: companyId, plant_id: plantId, is_active: row.is_active });
}

async function load(db) {
  ready = false;
  placements = new Map();
  writes.clear();
  // Failure leaves routing closed and is propagated to startup.
  const { rows } = await db.query('SELECT id, company_id, plant_id, is_active FROM machines');
  const next = new Map();
  for (const row of rows) {
    const entry = canonical(row);
    if (!entry) throw new Error('Machine placement contains an invalid owner or status');
    next.set(entry.id, entry);
  }
  placements = next;
  ready = true;
}

function upsert(row) {
  const entry = canonical(row);
  if (!ready || !entry) return false;
  placements.set(entry.id, entry);
  return true;
}

function remove(id) {
  placements.delete(positiveId(id));
}

function resolve(data) {
  if (!ready || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = positiveId(data.machine_id);
  const entry = placements.get(id);
  if (writes.has(id) || !entry?.is_active || entry.company_id !== positiveId(data.company_id)) return null;
  return entry;
}

function begin(id) {
  id = positiveId(id);
  if (!ready || !id) return null;
  const state = writes.get(id) || { count: 0, generation: 0 };
  state.count++;
  state.generation++;
  writes.set(id, state);
  return { id, state, settled: false };
}

async function finish(token, db) {
  if (!token || token.settled) return;
  token.settled = true;
  const { id, state } = token;
  if (writes.get(id) !== state) return;
  state.count--;
  if (state.count) return;
  const generation = state.generation;
  try {
    // Mutation-only query: after all concurrent writes settle, read the final
    // committed placement rather than trusting their response completion order.
    const { rows } = await db.query('SELECT id, company_id, plant_id, is_active FROM machines WHERE id = $1', [id]);
    if (writes.get(id) !== state || state.count || state.generation !== generation) return;
    const entry = rows.length ? canonical(rows[0]) : null;
    if (entry) placements.set(id, entry);
    else placements.delete(id);
    writes.delete(id);
  } catch (err) {
    if (writes.get(id) !== state || state.count || state.generation !== generation) return;
    placements.delete(id);
    writes.delete(id);
    // The database mutation already settled. Keep this machine's live route
    // closed until a successful edit or restart; do not turn a committed edit
    // into a retryable HTTP failure.
    console.error('Live machine placement refresh failed; routing closed:', id, err.message);
  }
}

module.exports = { load, upsert, remove, resolve, begin, finish };
