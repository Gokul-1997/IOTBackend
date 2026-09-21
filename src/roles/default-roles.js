/**
 * The default roles every company gets, and exactly what each one can open.
 *
 * These are system roles: one row with company_id NULL, shared by every
 * company, so "Supervisor" means the same thing in every tenant. A company
 * that wants something different creates its own role — that is what the
 * Roles screen is for — and a company's own roles are still capped by what
 * Manage Access grants the company, so a default role can never reach a
 * page the company has not been sold.
 *
 * Read this together with APP_MODULES in plans/plan.service.js: every key
 * below is built from a module there, and `resolveDefaultRoles` throws if a
 * module is renamed or an action removed out from under it, rather than
 * leaving a role silently holding a key that no longer opens anything.
 *
 * Admin is deliberately absent. COMPANY_ADMIN gets everything its company
 * was granted, decided by Manage Access rather than by a permission list
 * (see middleware/access.middleware.js), so listing pages for it here
 * would be a second source of truth that could disagree with the first.
 */

const { APP_MODULES } = require('../plans/plan.service');

/** Every action a module defines — for roles that own a screen outright. */
function all(moduleKey) {
  const mod = APP_MODULES.find(m => m.key === moduleKey);
  if (!mod) throw new Error(`default-roles: no module "${moduleKey}" in APP_MODULES`);
  return mod.actions.map(a => `page:${moduleKey}:${a}`);
}

/** Named actions only — for "view but not edit", "read but not export". */
function some(moduleKey, actions) {
  const mod = APP_MODULES.find(m => m.key === moduleKey);
  if (!mod) throw new Error(`default-roles: no module "${moduleKey}" in APP_MODULES`);
  for (const a of actions) {
    if (!mod.actions.includes(a)) {
      throw new Error(`default-roles: module "${moduleKey}" has no action "${a}"`);
    }
  }
  return actions.map(a => `page:${moduleKey}:${a}`);
}

/* The live floor screen and its per-machine drill-down. Every role that
   works on the floor gets both: the dashboard lists the machines and
   clicking one opens the detail, so granting the list without the detail
   produces cards that lead to a permission error. */
const LIVE_FLOOR = [...all('dashboard'), ...all('dashboard:live')];

/* Read access to the master data every screen's filters are built from.
   These are the legacy `machine.view`-style keys, not page keys: a good
   part of the API still enforces those (machines, operators, shifts, lines,
   components), so a role without them opens a page whose every dropdown
   comes back empty or 403. They are listed per role rather than granted
   wholesale — HR has no business writing machines, and SETTER none reading
   operators. */
const FLOOR_LOOKUPS = ['machine.view', 'line.view', 'shift.view', 'component.view'];

const DEFAULT_ROLES = [
  {
    name: 'SUPERVISOR',
    description: 'Runs the shift: the live floor, downtime, OEE and energy, plus the OEE, chart and quality reports (read only).',
    permissions: () => [
      ...LIVE_FLOOR,
      ...some('analytics-downtime', ['view', 'export']),
      ...some('analytics-oee',      ['view', 'export']),
      ...some('analytics-energy',   ['view']),   // not the tariff form
      ...all('oee-reports'),
      ...all('charts'),
      /* "Quality View Only" — the widgets, but not `edit`, which is what
         puts the quality-entry form on the page. */
      ...some('quality', ['view', 'oee-metrics', 'production-cards', 'hourly-chart'])
    ],
    legacy: [...FLOOR_LOOKUPS, 'operator.view']
  },
  {
    name: 'MAINTENANCE',
    description: 'Keeps the machines running: the maintenance, alarm, preventive, periodic and energy dashboards, and the maintenance report.',
    permissions: () => [
      ...LIVE_FLOOR,
      ...some('analytics-maintenance', ['view']),
      ...some('analytics-alarms',      ['view', 'export']),
      ...some('analytics-preventive',  ['view']),
      ...some('analytics-periodic',    ['view', 'export']),
      ...some('analytics-energy',      ['view']),
      ...all('maintenance-report'),
      /* The preventive and periodic screens raise tickets — "Generate due
         tickets", the threshold and schedule forms — and those routes are
         gated on page:maintenance (dashboard.routes.js). Without it the
         dashboards open and every button on them returns 403. */
      ...all('maintenance')
    ],
    legacy: [...FLOOR_LOOKUPS, 'operator.view']
  },
  {
    name: 'QUALITY',
    description: 'Owns quality: the OEE dashboard, and the quality screen including entry.',
    permissions: () => [
      ...some('analytics-oee', ['view', 'export']),
      ...all('quality')   // including `edit` — this role enters the readings
    ],
    legacy: ['machine.view', 'shift.view', 'component.view', 'operator.view']
  },
  {
    name: 'SETTER',
    description: 'Sends programs to the machines.',
    permissions: () => [
      /* No `delete`: removing a program from the library is a different
         risk from sending one to a controller, and this role is defined by
         the sending. */
      ...some('programs', ['view', 'upload', 'transfer', 'fetch'])
    ],
    legacy: ['machine.view', 'component.view']
  },
  {
    name: 'HR',
    description: 'Looks after the people: operator performance, and the operator records.',
    permissions: () => [
      ...some('analytics-operators', ['view', 'export']),
      ...all('operators')
    ],
    legacy: ['machine.view', 'shift.view', 'operator.view', 'operator.create', 'operator.update', 'operator.delete']
  }
];

/** Resolves every role's key list, throwing if any module or action is gone. */
function resolveDefaultRoles() {
  return DEFAULT_ROLES.map(r => {
    const permissions = [...new Set(r.permissions())];
    return { name: r.name, description: r.description, permissions, legacy: [...new Set(r.legacy || [])] };
  });
}

module.exports = { DEFAULT_ROLES, resolveDefaultRoles, all, some };
