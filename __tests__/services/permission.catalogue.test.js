/*
 * Every permission key a route enforces must exist in the catalogue.
 *
 * The Energy tariff form checked permit('page:dashboard') — an exact match
 * against a key that has never been in the permissions table (the catalogue
 * has page:dashboard:view and the widget keys, never the bare one). The check
 * could not pass for any company user, nothing failed at startup, and nothing
 * tested it: the button simply worked for nobody. A key a route demands that
 * cannot be granted is a page nobody can use.
 *
 * This walks every router, reads back the key each guard advertises, and
 * checks it against APP_MODULES (page keys) and LEGACY_API_PERMISSIONS
 * (legacy keys). It also checks the reverse for the dashboards: a module in
 * the catalogue that no route enforces is a toggle in Manage Access that
 * changes nothing.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/redis', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn(), on: jest.fn() }));

const fs   = require('fs');
const path = require('path');

const { APP_MODULES }            = require('../../src/plans/plan.service');
const { LEGACY_API_PERMISSIONS } = require('../../src/roles/role.service');

const catalogue = new Set();
for (const m of APP_MODULES) for (const a of m.actions) catalogue.add(`page:${m.key}:${a}`);
const legacy = new Set(LEGACY_API_PERMISSIONS.map(p => p.key));

/** Every *.routes.js under src, with the router each exports. */
function routers() {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.routes.js')) out.push(full);
    }
  })(path.join(__dirname, '../../src'));
  return out;
}

/** [{ file, method, path, key }] for each guard that advertises a key. */
function guardedRoutes() {
  const found = [];
  for (const file of routers()) {
    let router;
    try { router = require(file); } catch (e) { found.push({ file, loadError: e.message }); continue; }
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      for (const h of layer.route.stack) {
        if (h.handle && h.handle.requiredPermission) {
          found.push({
            file: path.relative(path.join(__dirname, '../..'), file),
            method: Object.keys(layer.route.methods)[0].toUpperCase(),
            path: layer.route.path,
            key: h.handle.requiredPermission
          });
        }
      }
    }
  }
  return found;
}

const routes = guardedRoutes();

describe('the scan can actually catch the original bug', () => {
  /* Feed it the exact line that shipped: the real permit() middleware guarding
     the bare page:dashboard key. If the scan reads it back and the catalogue
     rejects it, the checks below are not vacuous. */
  test('permit(\'page:dashboard\') is read back and is not a catalogue key', () => {
    const permit = require('../../src/middleware/permission.middleware');
    const r = require('express').Router();
    r.post('/energy/settings', (req, res, next) => next(), permit('page:dashboard'), () => {});
    const keys = r.stack[0].route.stack.map(h => h.handle.requiredPermission).filter(Boolean);
    expect(keys).toEqual(['page:dashboard']);
    expect(catalogue.has(keys[0])).toBe(false);
  });

  test('the real key it should have used is a catalogue key', () => {
    expect(catalogue.has('page:analytics-energy:settings')).toBe(true);
  });
});

describe('the router scan itself', () => {
  test('loads every router — one that fails to load would hide its keys from the checks below', () => {
    const broken = routes.filter(r => r.loadError);
    expect(broken).toEqual([]);
  });

  test('finds a meaningful number of guarded routes', () => {
    // a scan that silently found nothing would pass every test below
    expect(routes.filter(r => !r.loadError).length).toBeGreaterThan(40);
  });
});

describe('every enforced key can actually be granted', () => {
  const guarded = routes.filter(r => !r.loadError);

  test.each(guarded.map(r => [`${r.method} ${r.path}  (${r.file})`, r.key]))(
    '%s requires %s', (_label, key) => {
      const known = key.startsWith('page:') ? catalogue.has(key) : legacy.has(key);
      expect(known).toBe(true);
    });

  test('the dead Energy guard stays fixed: no route demands the bare page:dashboard key', () => {
    expect(guarded.filter(r => r.key === 'page:dashboard')).toEqual([]);
  });
});

describe('every analytics dashboard is actually enforced', () => {
  const analytics = APP_MODULES.filter(m => m.group === 'Analytics');
  const enforced = new Set(routes.filter(r => !r.loadError).map(r => r.key));

  /* The nine Phase 2 dashboards, plus the Maintenance Report — which is in
     this group because it is sold and revoked the same way, but is not one
     of the nine screens and has no analytics- prefix. */
  test('there are nine dashboards, one per Phase 2 screen', () => {
    expect(analytics.map(m => m.key).filter(k => k.startsWith('analytics-')).sort()).toEqual([
      'analytics-alarms', 'analytics-downtime', 'analytics-energy', 'analytics-factory',
      'analytics-maintenance', 'analytics-oee', 'analytics-operators',
      'analytics-periodic', 'analytics-preventive'
    ]);
  });

  test('the Maintenance Report is grantable and exportable in its own right', () => {
    const mod = APP_MODULES.find(m => m.key === 'maintenance-report');
    expect(mod).toBeTruthy();
    expect(mod.actions).toEqual(['view', 'export']);
    expect(enforced.has('page:maintenance-report:view')).toBe(true);
    expect(enforced.has('page:maintenance-report:export')).toBe(true);
  });

  test('Production Plans is gone from the catalogue — it was never in Phase 2', () => {
    expect(APP_MODULES.some(m => m.key === 'production-plans')).toBe(false);
    expect([...catalogue].filter(k => k.includes('production-plans'))).toEqual([]);
  });

  test.each(analytics.flatMap(m => m.actions.map(a => [`page:${m.key}:${a}`])))(
    '%s is required by at least one route — otherwise ticking it in Manage Access changes nothing',
    key => expect(enforced.has(key)).toBe(true));

  test('every export route needs the export key, not just the view key', () => {
    const exports_ = routes.filter(r => /export/.test(r.path || '') && /analytics/.test(r.key));
    expect(exports_.length).toBeGreaterThanOrEqual(6);
    for (const r of exports_) expect(r.key).toMatch(/:export$/);
  });

  test('the Energy tariff save needs its own settings key', () => {
    const save = routes.find(r => r.method === 'POST' && r.path === '/energy/settings');
    expect(save.key).toBe('page:analytics-energy:settings');
  });
});

describe('the catalogue itself', () => {
  test('no key is listed twice', () => {
    let n = 0;
    for (const m of APP_MODULES) n += m.actions.length;
    expect(catalogue.size).toBe(n);
  });

  test('the analytics prefix cannot collide with the live-dashboard prefix', () => {
    // the frontend matches on `page:dashboard:` prefixes — an analytics key
    // starting with that would let a single live widget open all nine
    for (const m of APP_MODULES.filter(m => m.group === 'Analytics')) {
      expect(`page:${m.key}:`.startsWith('page:dashboard:')).toBe(false);
    }
  });
});
