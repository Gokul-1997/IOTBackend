const {refreshQueued,floor,next}=require('../../src/lib/energy-refresh');
test('closed boundaries use IST, including the half-hour offset and month transition',()=>{
  expect(new Date(floor('2026-10-29T05:15:00Z','hour')).toISOString()).toBe('2026-10-29T04:30:00.000Z');
  expect(new Date(next(floor('2026-10-31T20:00:00Z','month'),'month')).toISOString()).toBe('2026-11-30T18:30:00.000Z');
});
test('no refresh queue means no extension lookup or refresh call',async()=>{
  const client={query:jest.fn(async()=>({rows:[]}))};
  await expect(refreshQueued(client,4,19)).resolves.toEqual({refreshed:0});
  expect(client.query).toHaveBeenCalledTimes(1);
});
test('refreshes only closed buckets and deletes only the unchanged queue version',async()=>{
  jest.useFakeTimers().setSystemTime(new Date('2026-11-02T10:10:00Z'));
  const client={query:jest.fn(async sql=>({rows:sql.startsWith('SELECT *,')?[{
    from_at:'2026-10-28T10:00:00Z',through_at:'2026-11-02T10:09:59Z',version:'2026-11-02 10:09:59.123456+00'
  }]:sql.includes('FROM pg_extension')?[{extversion:'2.19.3'}]:[]}))};
  try{
    await expect(refreshQueued(client,4,19)).resolves.toEqual({refreshed:4});
    const calls=client.query.mock.calls.filter(([sql])=>sql.startsWith('CALL'));
    expect(calls).toHaveLength(4);
    for(const [,values]of calls)expect(values[1].getTime()).toBeLessThanOrEqual(Date.now());
    const hourly=calls.find(([sql])=>sql.includes('energy_counter_hourly'));
    expect(hourly[1][1].toISOString()).toBe('2026-11-02T09:30:00.000Z');
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('updated_at=$3'),[4,19,'2026-11-02 10:09:59.123456+00']);
  }finally{jest.useRealTimers();}
});
test('a compressed-history refresh failure keeps the correction queued for safe reader fallback',async()=>{
  const client={query:jest.fn(async sql=>{
    if(sql.startsWith('SELECT *,'))return {rows:[{from_at:'2026-01-01T00:00:00Z',through_at:'2026-01-02T00:00:00Z'}]};
    if(sql.includes('FROM pg_extension'))return {rows:[{extversion:'2.19.3'}]};
    if(sql.startsWith('CALL'))throw Object.assign(new Error('compressed'),{code:'55000'});
    return {rows:[]};
  })};
  await expect(refreshQueued(client,4,19)).resolves.toEqual({refreshed:0,error:'55000'});
  expect(client.query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('SET last_error'),[4,19,'55000']);
});
