const pool=require('../../src/db');
const service=require('../../src/shifts/shift.service');
let client;
beforeEach(()=>{
  client={release:jest.fn(),query:jest.fn(async(sql)=>{
    if(sql.includes('SELECT id FROM shifts'))return {rowCount:1,rows:[{id:2}]};
    if(sql.includes('FROM pg_constraint'))return {rows:[{relation:'public.energy_counter_intervals',column_name:'shift_id',table_name:'energy_counter_intervals'}]};
    if(sql.startsWith('SELECT EXISTS'))return {rows:[{used:false}]};
    return {rows:[],rowCount:1};
  })};
  pool.connect.mockResolvedValue(client);
});
test('a referenced shift is refused without deleting any historical or configuration row',async()=>{
  client.query.mockImplementation(async sql=>{
    if(sql.includes('SELECT id FROM shifts'))return {rowCount:1,rows:[{id:2}]};
    if(sql.includes('FROM pg_constraint'))return {rows:[{relation:'public.energy_counter_intervals',column_name:'shift_id',table_name:'energy_counter_intervals'}]};
    if(sql.startsWith('SELECT EXISTS'))return {rows:[{used:true}]};
    return {rows:[]};
  });
  await expect(service.deleteShift(2,4)).rejects.toMatchObject({status:409});
  expect(client.query.mock.calls.some(([sql])=>/^DELETE|^UPDATE/.test(sql))).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalled();
});
test('a shift owned by another tenant is refused before checking references',async()=>{
  client.query.mockImplementation(async sql=>sql.includes('SELECT id FROM shifts')?{rowCount:0,rows:[]}:{rows:[]});
  await expect(service.deleteShift(2,5)).rejects.toMatchObject({status:404});
  expect(client.query).toHaveBeenCalledWith('SELECT id FROM shifts WHERE id=$1 AND company_id=$2 FOR UPDATE',[2,5]);
  expect(client.query.mock.calls.some(([sql])=>sql.includes('pg_constraint'))).toBe(false);
});
test('an unused shift deletes only its configuration and master row in one transaction',async()=>{
  await service.deleteShift(2,4);
  const writes=client.query.mock.calls.filter(([sql])=>/^DELETE|^UPDATE/.test(sql));
  expect(writes.map(([sql])=>sql)).toEqual(['DELETE FROM machine_shift_config WHERE shift_id=$1','DELETE FROM shifts WHERE id=$1 AND company_id=$2']);
  expect(client.query).toHaveBeenLastCalledWith('COMMIT');
});
test('a later FK failure rolls back prior configuration changes and reports a conflict',async()=>{
  const original=client.query.getMockImplementation();
  client.query.mockImplementation(async(sql,args)=>{
    if(sql.startsWith('DELETE FROM shifts'))throw Object.assign(new Error('referenced'),{code:'23503'});
    return original(sql,args);
  });
  await expect(service.deleteShift(2,4)).rejects.toMatchObject({status:409});
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
