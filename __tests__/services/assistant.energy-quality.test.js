jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/dashboard/energy.service', () => ({ getEnergy: jest.fn() }));
jest.mock('../../src/reports/report.service', () => ({}));
const energySvc = require('../../src/dashboard/energy.service');
const { TOOLS } = require('../../src/assistant/assistant.tools');

const quality = { machines: 3, reporting: 2, tariff_configured: true,
  rejected_intervals: 1, energy_complete: false, cost_complete: false, note: 'Partial meter coverage.' };
const run = data => {
  energySvc.getEnergy.mockResolvedValue(data);
  return TOOLS.energy_summary.run({ company_id: 4 },
    { date_from: '2026-10-29', date_to: '2026-10-29' }, { today: '2026-10-29' });
};

test('the assistant receives rejected-interval coverage and canonical sources with a partial total', async () => {
  const result = await run({ kpis: { total_kwh: 1.25, total_cost: null, kwh_per_part: null },
    coverage: quality, energy_source: 'canonical_energy_intervals',
    by_shift_source: 'canonical_energy_intervals', cost_basis: 'current_tariff_estimate' });
  expect(result.data.totals).toMatchObject({ kwh: 1.25, cost: null, kwh_per_part: null });
  expect(result.data.coverage).toMatchObject({ reporting_energy: 2, rejected_intervals: 1,
    energy_complete: false, cost_complete: false });
  expect(result.data).toMatchObject({ energy_source: 'canonical_energy_intervals',
    by_shift_source: 'canonical_energy_intervals', cost_basis: 'current_tariff_estimate' });
});

test('unknown energy retains its coverage explanation and never becomes zero for the assistant', async () => {
  const result = await run({ kpis: { total_kwh: null }, coverage: { ...quality, reporting: 0 },
    energy_source: 'canonical_energy_intervals', by_shift_source: 'canonical_energy_intervals' });
  expect(result.data).toMatchObject({ records: 0, note: 'Partial meter coverage.',
    energy_source: 'canonical_energy_intervals', coverage: { reporting_energy: 0, energy_complete: false } });
  expect(result.data).not.toHaveProperty('totals');
});

test('a genuine zero consumption remains an energy total', async () => {
  const result = await run({ kpis: { total_kwh: 0, total_cost: 0, kwh_per_part: 0 },
    coverage: { ...quality, reporting: 3, rejected_intervals: 0, energy_complete: true, cost_complete: true } });
  expect(result.data.totals).toMatchObject({ kwh: 0, cost: 0 });
  expect(result.data.coverage.energy_complete).toBe(true);
});
