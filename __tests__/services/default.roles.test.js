/*
 * The default role templates every new company starts from.
 *
 * Each company gets its own copy when S&T creates it, and its admin changes
 * them from there. The lists are pinned because they were agreed with the
 * customer: a silent change to one is a change to what every new company's
 * shift supervisor can see on the floor.
 */

const { resolveDefaultRoles, DEFAULT_ROLES } = require('../../src/roles/default-roles');
const { APP_MODULES } = require('../../src/plans/plan.service');

const roles = resolveDefaultRoles();
const byName = Object.fromEntries(roles.map(r => [r.name, r]));
const catalogue = new Set(APP_MODULES.flatMap(m => m.actions.map(a => `page:${m.key}:${a}`)));

describe('the default role set', () => {
  test('is exactly the five the customer specified, beside Admin', () => {
    expect(roles.map(r => r.name)).toEqual(['SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR']);
  });

  test('Admin is deliberately not one of them — it is governed by Manage Access', () => {
    expect(roles.some(r => r.name === 'COMPANY_ADMIN')).toBe(false);
    expect(roles.some(r => r.name === 'ADMIN')).toBe(false);
  });

  test('every role has a description an admin can read in the Roles screen', () => {
    for (const r of roles) expect(r.description.length).toBeGreaterThan(20);
  });

  test('every key exists in the catalogue — a role cannot hold a dead permission', () => {
    for (const r of roles) {
      for (const key of r.permissions) {
        expect(catalogue.has(key)).toBe(true);
      }
    }
  });

  test('no role lists the same key twice', () => {
    for (const r of roles) expect(new Set(r.permissions).size).toBe(r.permissions.length);
  });

  test('a renamed module or dropped action fails loudly instead of silently', () => {
    const { all, some } = require('../../src/roles/default-roles');
    expect(() => all('no-such-module')).toThrow(/no module/);
    expect(() => some('quality', ['no-such-action'])).toThrow(/no action/);
  });
});

describe('SUPERVISOR — the shift', () => {
  const r = byName.SUPERVISOR;

  test('gets the live floor, downtime, OEE and energy dashboards', () => {
    expect(r.permissions).toContain('page:dashboard:view');
    expect(r.permissions).toContain('page:dashboard:live:view');
    expect(r.permissions).toContain('page:analytics-downtime:view');
    expect(r.permissions).toContain('page:analytics-oee:view');
    expect(r.permissions).toContain('page:analytics-energy:view');
  });

  test('gets the OEE, chart and quality reports', () => {
    expect(r.permissions).toContain('page:oee-reports:view');
    expect(r.permissions).toContain('page:charts:view');
    expect(r.permissions).toContain('page:quality:view');
  });

  test('quality is view only — no entry form', () => {
    expect(r.permissions).not.toContain('page:quality:edit');
  });

  test('cannot change the energy tariff, which is an admin setting', () => {
    expect(r.permissions).not.toContain('page:analytics-energy:settings');
  });

  test('gets none of the maintenance screens', () => {
    expect(r.permissions.filter(k => k.includes('maintenance'))).toEqual([]);
  });
});

describe('MAINTENANCE — the machines', () => {
  const r = byName.MAINTENANCE;

  test('gets the live floor and the five dashboards it was given', () => {
    for (const key of ['page:dashboard:view', 'page:analytics-maintenance:view',
                       'page:analytics-alarms:view', 'page:analytics-preventive:view',
                       'page:analytics-periodic:view', 'page:analytics-energy:view']) {
      expect(r.permissions).toContain(key);
    }
  });

  test('gets the maintenance report, and can export it', () => {
    expect(r.permissions).toContain('page:maintenance-report:view');
    expect(r.permissions).toContain('page:maintenance-report:export');
  });

  /* The preventive and periodic dashboards raise tickets, and those routes
     are gated on page:maintenance — without it the screens open and every
     button on them returns 403. */
  test('can actually work the tickets those dashboards raise', () => {
    expect(r.permissions).toContain('page:maintenance:view');
    expect(r.permissions).toContain('page:maintenance:edit');
    expect(r.permissions).toContain('page:maintenance:delete');
  });

  test('gets none of the reporting screens that belong to the supervisor', () => {
    expect(r.permissions).not.toContain('page:oee-reports:view');
    expect(r.permissions).not.toContain('page:charts:view');
  });
});

describe('QUALITY — the readings', () => {
  const r = byName.QUALITY;

  test('gets the OEE dashboard and the quality screen', () => {
    expect(r.permissions).toContain('page:analytics-oee:view');
    expect(r.permissions).toContain('page:quality:view');
  });

  test('can enter readings, unlike the supervisor', () => {
    expect(r.permissions).toContain('page:quality:edit');
  });

  test('gets no other dashboard — not even the live floor', () => {
    expect(r.permissions).not.toContain('page:dashboard:view');
    expect(r.permissions.filter(k => k.startsWith('page:analytics-') && !k.startsWith('page:analytics-oee')))
      .toEqual([]);
  });
});

describe('SETTER — the programs', () => {
  const r = byName.SETTER;

  test('can send a program to a machine', () => {
    expect(r.permissions).toContain('page:programs:view');
    expect(r.permissions).toContain('page:programs:upload');
    expect(r.permissions).toContain('page:programs:transfer');
    expect(r.permissions).toContain('page:programs:fetch');
  });

  /* Removing a program from the library is a different risk from sending
     one to a controller, and this role is defined by the sending. */
  test('cannot delete from the program library', () => {
    expect(r.permissions).not.toContain('page:programs:delete');
  });

  test('gets nothing else at all', () => {
    expect(r.permissions.every(k => k.startsWith('page:programs:'))).toBe(true);
  });
});

describe('HR — the people', () => {
  const r = byName.HR;

  test('gets operator performance and the operator records', () => {
    expect(r.permissions).toContain('page:analytics-operators:view');
    expect(r.permissions).toContain('page:operators:view');
    expect(r.permissions).toContain('page:operators:create');
    expect(r.permissions).toContain('page:operators:edit');
    expect(r.permissions).toContain('page:operators:delete');
  });

  test('gets no production screen — this role is not on the floor', () => {
    expect(r.permissions).not.toContain('page:dashboard:view');
    expect(r.permissions).not.toContain('page:machines:view');
  });
});

describe('legacy API keys — the half of access that is not page keys', () => {
  /* A good part of the API still enforces machine.view-style keys. They are
     derived from each template's pages, from what those pages actually call
     (default-roles.LEGACY_FOR_PAGE) — no more, no less. */
  test('each role gets exactly the keys its pages need', () => {
    expect(byName.SUPERVISOR.legacy).toEqual(['line.view']);       // Quality page's line filter
    expect(byName.MAINTENANCE.legacy).toEqual([]);                 // its pages call none of those routes
    expect(byName.QUALITY.legacy).toEqual(['line.view']);
    expect(byName.SETTER.legacy).toEqual(['machine.view']);        // Program Transfer lists machines
    expect(byName.HR.legacy).toEqual(expect.arrayContaining(['operator.view', 'shift.view']));
  });

  test('HR can write operators, because that is the screen it was given', () => {
    expect(byName.HR.legacy).toEqual(expect.arrayContaining(
      ['operator.view', 'operator.create', 'operator.update', 'operator.delete']));
  });

  test('no role is handed a legacy write it has no screen for', () => {
    for (const r of roles) {
      for (const key of r.legacy) {
        if (/\.(create|update|delete)$/.test(key)) {
          expect(r.name).toBe('HR');           // only HR has any legacy write
          expect(key.startsWith('operator.')).toBe(true);
        }
      }
    }
  });

  /* The Quality page loads its line filter from /api/lines, which checks
     line.view. QUALITY shipped without it, so its one screen opened with an
     empty filter and a 403 behind it. */
  test('every role with the Quality page can load its line filter', () => {
    for (const name of ['SUPERVISOR', 'QUALITY']) {
      expect(byName[name].legacy).toContain('line.view');
    }
  });

  test('SETTER is not given operator data it has no reason to see', () => {
    expect(byName.SETTER.legacy).not.toContain('operator.view');
  });
});

describe('the definitions themselves', () => {
  test('permissions are declared lazily so a catalogue change is caught at call time', () => {
    for (const r of DEFAULT_ROLES) expect(typeof r.permissions).toBe('function');
  });

  test('resolving twice gives the same answer — nothing accumulates', () => {
    expect(resolveDefaultRoles()).toEqual(resolveDefaultRoles());
  });
});
