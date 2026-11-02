const {AsyncLocalStorage}=require('node:async_hooks');
const {createLimiter}=require('../../src/dashboard/energy-db');
test('bounds simultaneous DB work and preserves each request async context',async()=>{
  const context=new AsyncLocalStorage(),limit=createLimiter({max:2});
  let running=0,peak=0;const releases=[];
  const tasks=Array.from({length:8},(_,id)=>context.run(id,()=>limit(async()=>{
    running++;peak=Math.max(peak,running);expect(context.getStore()).toBe(id);
    await new Promise(resolve=>releases.push(resolve));running--;return id;
  })));
  for(let i=0;i<4;i++){
    await new Promise(resolve=>setImmediate(resolve));
    for(const done of releases.splice(0))done();
  }
  await expect(Promise.all(tasks)).resolves.toEqual([0,1,2,3,4,5,6,7]);
  expect(peak).toBe(2);
});
test('errors release slots and an overflowing queue refuses work without calling it',async()=>{
  const limit=createLimiter({max:1,maxQueued:1});let release;
  const first=limit(()=>new Promise(resolve=>{release=resolve;}));
  await new Promise(resolve=>setImmediate(resolve));
  const second=limit(()=>{throw Error('query failed');});
  const unused=jest.fn();await expect(limit(unused)).rejects.toMatchObject({status:503});
  expect(unused).not.toHaveBeenCalled();release();await first;
  await expect(second).rejects.toThrow('query failed');
  await expect(limit(async()=>42)).resolves.toBe(42);
});
test('expired waiting requests never begin a DB query',async()=>{
  jest.useFakeTimers();
  const limit=createLimiter({max:1,waitMs:10});let release;
  const first=limit(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  const work=jest.fn(),pending=limit(work);const assertion=expect(pending).rejects.toMatchObject({status:503});
  await jest.advanceTimersByTimeAsync(11);await assertion;
  expect(work).not.toHaveBeenCalled();release();await first;jest.useRealTimers();
});
