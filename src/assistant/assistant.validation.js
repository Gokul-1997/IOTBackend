/* Check numerical claims against the data actually read in this question.
 * This does not certify prose or diagnose causes: the prompt must still avoid
 * unsupported explanations. Dates, machine names and alarm codes are compared
 * as labels rather than interpreted as measured quantities. */
const NUMBER = /(?<![\p{L}\d])[-+]?\d[\d,]*(?:\.\d+)?(?![\p{L}\d])/gu;
const valueOf = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^[-+]?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
const label = key => key.replaceAll('_', ' ').replace(/\bpct\b/g, '%');

function inspect(text, evidence) {
  const values = [];
  const metrics = [];
  const strings = new Set();
  const series = new Map();
  function visit(data, path = '') {
    if (data == null) return;
    const number = valueOf(data);
    if (number !== null) {
      if (/(^|\.)(id|.*_id)$/.test(path)) return;
      values.push(number); metrics.push({ path, value: number });
      const comparable = path.replace(/\[\d+\]/g, '[]');
      const list = series.get(comparable) || [];
      list.push(number); series.set(comparable, list);
      if (/_hours$/.test(path)) values.push(number * 60, number * 3600);
      if (/_minutes$/.test(path)) values.push(number / 60, number * 60);
      if (/_seconds$/.test(path)) values.push(number / 60, number / 3600);
    } else if (typeof data === 'string') { if (data.length > 1 && /\d/.test(data)) strings.add(data); }
    else if (Array.isArray(data)) data.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (typeof data === 'object') Object.entries(data).forEach(([k, v]) => visit(v, path ? `${path}.${k}` : k));
  }
  evidence.forEach(item => visit(item.data));
  // Only compare the same aggregate metric across tool reads, never unrelated
  // machine rows or arbitrary numbers that happen to appear in a report.
  for (const [path, list] of series) {
    if (path.includes('[]') || list.length < 2 || list.length > 4) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      for (const delta of [Math.abs(b - a), b - a, a - b]) { values.push(delta); metrics.push({ path, value: delta }); }
      const changes = [
        ...(a !== 0 ? [(b - a) / a * 100, Math.abs((b - a) / a * 100)] : []),
        ...(b !== 0 ? [(a - b) / b * 100, Math.abs((a - b) / b * 100)] : [])
      ];
      for (const value of changes) { values.push(value); metrics.push({ path: `${path}.change_pct`, value }); }
    }
  }
  let remaining = String(text);
  for (const value of [...strings].sort((a, b) => b.length - a.length)) {
    remaining = remaining.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  // Numbered instructions are not measurements. Other numbers must be read
  // from the current results, including dates not found in the source labels.
  remaining = remaining.replace(/^\s*\d+[.)]\s+/gm, '');
  const claims = [...remaining.matchAll(NUMBER)];
  const unsupported = claims.filter(match => {
    const raw = match[0];
    const candidate = Number(raw.replaceAll(',', ''));
    const decimals = raw.includes('.') ? Math.min(6, raw.split('.')[1].length) : 0;
    const before = remaining.slice(Math.max(0, match.index - 55), match.index);
    const after = remaining.slice(match.index + raw.length);
    let candidates = values;
    if (/^\s*%/.test(after)) {
      const named = before.match(/\b(oee|availability|performance|quality|efficiency|coverage|utili[sz]ation)(?:\s+(?:rate|is|was|of|at))?\s*[:=]?\s*$/i)?.[1]?.toLowerCase();
      candidates = metrics.filter(m => /pct|percent/.test(m.path) && (!named || m.path.toLowerCase().includes(named))).map(m => m.value);
    } else if (/^\s*(pcs\b|parts?\b|pieces\b)/i.test(after)) {
      candidates = metrics.filter(m => /parts|produced|good|reject|quantity|qty/.test(m.path)).map(m => m.value);
    } else if (/^\s*kwh\b/i.test(after)) {
      candidates = metrics.filter(m => /energy|kwh/.test(m.path)).map(m => m.value);
    }
    return !candidates.some(value => Number(value.toFixed(decimals)) === candidate);
  }).map(match => match[0]);
  return { valid: unsupported.length === 0, claims: claims.length, unsupported };
}

/** A correction uses recorded aggregate values, never the rejected draft. */
function databaseSummary(evidence) {
  const lines = [];
  for (const item of evidence) {
    const data = item.data;
    const aggregate = data?.totals || data?.overall || data?.counts;
    if (!aggregate) continue;
    const facts = Object.entries(aggregate).filter(([key, value]) =>
      valueOf(value) !== null && !/(^id$|_id$)/.test(key)).slice(0, 5);
    if (!facts.length) continue;
    const period = data.period ? ` (${data.period.from} to ${data.period.to})` : '';
    const filter = Object.entries(data.filters || {}).filter(([, v]) => v).map(([, v]) => v).join(', ');
    lines.push(`${data.report || item.source?.report || 'Database records'}${period}${filter ? ` - ${filter}` : ''}:`);
    for (const [key, value] of facts) lines.push(`- ${label(key)}: ${value}`);
    if (lines.length >= 12) break;
  }
  return lines.length ? 'Verified database values:\n' + lines.join('\n') : null;
}

module.exports = { inspect, databaseSummary };
