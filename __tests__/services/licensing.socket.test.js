const jwt=require('jsonwebtoken');const runtime=require('../../src/licensing/runtime');const config=require('../../src/licensing/config');
const {attach}=require('../../src/lib/socket-server');
afterEach(()=>jest.restoreAllMocks());
test('a valid session cannot open a live socket when its license is blocked',async()=>{
  jest.spyOn(jwt,'verify').mockReturnValue({user_id:1,roles:[],auth_revision:'0'});
  jest.spyOn(runtime,'assertAccess').mockRejectedValue(Object.assign(new Error('expired'),{code:'LICENSE_EXPIRED'}));
  let authenticate;const io={use:fn=>{authenticate=fn;},on:jest.fn()};
  attach(io,{db:{query:async()=>({rows:[{company_id:4,is_active:true,company_active:true,auth_revision:'0'}]})}});
  const next=jest.fn();await authenticate({handshake:{auth:{token:'valid-session'}}},next);
  expect(next).toHaveBeenCalledWith(expect.any(Error));expect(runtime.assertAccess).toHaveBeenCalledWith(expect.objectContaining({company_id:4}));
});
test('one process sweep checks each company once and disconnects already connected expired users',async()=>{
  jest.spyOn(config,'enabled').mockReturnValue(true);let sweep;const timer={unref:jest.fn()};
  jest.spyOn(global,'setInterval').mockImplementation(fn=>{sweep=fn;return timer;});
  const gate=jest.spyOn(runtime,'assertAccess').mockImplementation(async user=>{if(user.company_id===4)throw Error('expired');});
  const sockets=Array.from({length:20},()=>({user:{company_id:4},disconnect:jest.fn()}));
  const allowed={user:{company_id:5},disconnect:jest.fn()};sockets.push(allowed);
  attach({use:jest.fn(),on:jest.fn(),sockets:{sockets:new Map(sockets.map((s,i)=>[i,s]))}},{db:{}});
  await sweep();expect(gate).toHaveBeenCalledTimes(2);for(const s of sockets.slice(0,20))expect(s.disconnect).toHaveBeenCalledWith(true);expect(allowed.disconnect).not.toHaveBeenCalled();
});
