/**
 * The default roles every company starts with.
 *
 * These are templates, not shared roles. When S&T creates a company, each
 * template becomes a role OWNED by that company (company_id set), holding
 * only the pages the company has been given in Manage Access. From then on
 * the company admin manages them completely — adds or removes pages,
 * renames, copies, deletes — and S&T takes no action on them.
 * (role.service.createDefaultRolesForCompany; migration 027 did the same
 * for the companies that existed before this.)
 *
 * Changing a template here changes what NEW companies start with. It does
 * not reach into an existing company's roles: those are that company's now.
 *
 * Every page key below is built from a module in APP_MODULES, and
 * `resolveDefaultRoles` throws if a module is renamed or an action removed,
 * rather than leaving a template holding a key that opens nothing.
 *
 * Admin is deliberately absent. COMPANY_ADMIN gets everything its company
 * was granted, decided by Manage Access rather than by a page list.
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
    ]
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
    ]
  },
  {
    name: 'QUALITY',
    description: 'Owns quality: the OEE dashboard, and the quality screen including entry.',
    permissions: () => [
      ...some('analytics-oee', ['view', 'export']),
      ...all('quality')   // including `edit` — this role enters the readings
    ]
  },
  {
    name: 'SETTER',
    description: 'Sends programs to the machines.',
    permissions: () => [
      /* No `delete`: removing a program from the library is a different
         risk from sending one to a controller, and this role is defined by
         the sending. */
      ...some('programs', ['view', 'upload', 'transfer', 'fetch'])
    ]
  },
  {
    name: 'HR',
    description: 'Looks after the people: operator performance, and the operator records.',
    permissions: () => [
      ...some('analytics-operators', ['view', 'export']),
      ...all('operators')
    ]
  }
];

/* ── Older API keys a page depends on ─────────────────────────
   Part of the API still checks `machine.view`-style keys rather than page
   keys (machines, lines, shifts and operators routes). A role holding only
   page keys therefore opens a page and then gets 403 from the calls behind
   it — the Program Transfer page, for one, lists its machines through
   /api/machines. Every role, default or a company's own, gets these derived
   from its pages so the two halves of access can never disagree. */
const LEGACY_FOR_PAGE = {
  // the machine form loads its line dropdown from /api/lines
  machines:  { view: ['machine.view', 'line.view'], create: ['machine.create'], edit: ['machine.update'], delete: ['machine.delete'] },
  lines:     { view: ['line.view'],     create: ['line.create'],     edit: ['line.update'],     delete: ['line.delete'] },
  // the shift DELETE route checks shift.update, not shift.delete
  shifts:    { view: ['shift.view'],    create: ['shift.create'],    edit: ['shift.update'],    delete: ['shift.update'] },
  // the operator form loads the shift list from /api/shifts
  operators: { view: ['operator.view', 'shift.view'], create: ['operator.create'], edit: ['operator.update'], delete: ['operator.delete'] },
  component: { view: ['component.view'], create: ['component.create'], edit: ['component.update'], delete: ['component.delete'] },
  // pages that read those lists for their own dropdowns and filters
  programs:         { view: ['machine.view'] },
  assignments:      { view: ['operator.view', 'shift.view'] },
  'machine-shifts': { view: ['shift.view'] },
  job:              { view: ['machine.view', 'operator.view'] },
  quality:          { view: ['line.view'] },
  reports:          { view: ['machine.view', 'operator.view', 'shift.view'] }
};

/** The legacy keys a set of page keys needs, e.g. page:machines:edit → machine.update. */
function legacyKeysFor(pageKeys = []) {
  const out = new Set();
  for (const key of pageKeys) {
    const m = /^page:(.+):([^:]+)$/.exec(key);
    if (!m) continue;
    for (const k of (LEGACY_FOR_PAGE[m[1]]?.[m[2]] || [])) out.add(k);
  }
  return [...out];
}

/**
 * Resolves every template's pages, and the older API keys those pages need,
 * throwing if any module or action is gone.
 */
function resolveDefaultRoles() {
  return DEFAULT_ROLES.map(r => {
    const permissions = [...new Set(r.permissions())];
    return { name: r.name, description: r.description, permissions, legacy: legacyKeysFor(permissions) };
  });
}

/** Names of the default roles, e.g. to retire the old shared rows by name. */
const DEFAULT_ROLE_NAMES = DEFAULT_ROLES.map(r => r.name);

module.exports = { DEFAULT_ROLES, DEFAULT_ROLE_NAMES, resolveDefaultRoles, legacyKeysFor, LEGACY_FOR_PAGE, all, some };
