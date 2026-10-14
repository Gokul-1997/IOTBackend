const { run, current, resolved, plantSql, sharedEntityPlantSql, nullablePlantSql, cacheScope } = require('../../src/lib/read-scope');
const cache = require('../../src/dashboard/cache');

test('plant scope follows each concurrent request through async work and ends afterwards', async () => {
  const calls = [8, 10].map(plant_id => run({ company_id: 4, plant_id }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return [current(), plantSql('p.machine_id'), cacheScope()];
  }));
  const results = await Promise.all(calls);
  expect(results.map(r => r[0].plantId)).toEqual([8, 10]);
  expect(results[0][1]).toContain('authorized_machine.plant_id = 8');
  expect(results[1][1]).toContain('authorized_machine.plant_id = 10');
  expect(current()).toBeUndefined();
  expect(plantSql('machine_id')).toBe(''); // background work remains company-wide
});

test('server request scope overrides explicit filters, including company admins', () => {
  run({ company_id: 4, plant_id: 8 }, () => {
    expect(resolved(10, 5)).toEqual({ companyId: 4, plantId: 8 });
    expect(plantSql('m.id', 10, 5)).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 8');
  });
  run({ company_id: 4, plant_id: 8, roles: ['COMPANY_ADMIN'] }, () => {
    expect(plantSql('m.id', 8, 4)).toBe('');
    expect(cacheScope()).toBe('company');
  });
});

test('only validated integer authorization values and constant SQL identifiers are accepted', () => {
  expect(() => run({ company_id: 4, plant_id: '8 OR TRUE' }, () => {})).toThrow();
  expect(() => plantSql('m.id; DROP TABLE machines', 8, 4)).toThrow('Invalid scoped SQL column');
  expect(() => plantSql('m.id', 8, null)).toThrow('No company assigned');
});

test('shared shifts and company settings retain NULL scope without admitting another plant', () => {
  run({ company_id: 4, plant_id: 8 }, () => {
    expect(sharedEntityPlantSql('shifts')).toContain('shifts.plant_id IS NULL OR');
    expect(sharedEntityPlantSql('shifts')).toContain('shifts.plant_id = 8');
    expect(nullablePlantSql('es.machine_id')).toContain('es.machine_id IS NULL OR');
    expect(nullablePlantSql('es.machine_id')).toContain('authorized_machine.plant_id = 8');
  });
});

test('cached and in-flight dashboard answers separate authorization plants and company-wide users', async () => {
  let calls = 0;
  const get = user => run(user, () => cache.remember('plant-unit-scope', 4,
    { authorization_plant: 'client-cannot-override' }, 30, async () => { calls++; return user.roles ? 'company' : user.plant_id; }));
  expect(await Promise.all([get({ company_id: 4, plant_id: 8 }), get({ company_id: 4, plant_id: 10 }), get({ company_id: 4, plant_id: 8, roles: ['ADMIN'] })])).toEqual([8, 10, 'company']);
  expect(calls).toBe(3);
});
