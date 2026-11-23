const fs=require('node:fs');
const path=require('node:path');
jest.mock('../../scripts/migrate',()=>({
  ...jest.requireActual('../../scripts/migrate'),run:jest.fn(async()=>0)
}));
const {run,sha}=require('../../scripts/migrate');
const {apply,files}=require('../../scripts/apply-energy-migrations');
const checksum=sha(fs.readFileSync(path.join(__dirname,'../../src/migrations/063_sparse_energy_observations.sql'),'utf8'));
beforeEach(()=>run.mockClear());
test('the selected upgrade includes the additive THD storage migration',()=>{
  expect(files).toEqual(['064_energy_interval_pipeline.sql','065_energy_continuous_aggregates.sql','066_energy_meter_thd.sql']);
});
test('refuses a missing or drifted sparse-source prerequisite before applying anything',async()=>{
  const pool={query:jest.fn(async()=>({rows:[{checksum:'wrong'}]}))};
  await expect(apply(pool)).rejects.toThrow('verified checksum');
  expect(run).not.toHaveBeenCalled();
});
test.each([false,true])('only the selected additive migrations can be run; write=%s',async write=>{
  let dir;
  const pool={query:jest.fn(async()=>({rows:[{checksum}]}))};
  run.mockImplementationOnce(async(_pool,options)=>{
    dir=options.dir;expect(fs.readdirSync(dir).sort()).toEqual(files);
    expect(options.args).toEqual(write?[]:['--dry']);return 0;
  });
  await expect(apply(pool,{write})).resolves.toBe(0);
  expect(fs.existsSync(dir)).toBe(false);
});
test('temporary migration catalogue is removed after a runner failure',async()=>{
  let dir;run.mockImplementationOnce(async(_pool,options)=>{dir=options.dir;throw Error('migration failed');});
  await expect(apply({query:async()=>({rows:[{checksum}]})},{write:true})).rejects.toThrow('migration failed');
  expect(fs.existsSync(dir)).toBe(false);
});
