const express=require('express');const request=require('supertest');const db=require('../../src/db');
jest.mock('../../src/middleware/auth.middleware',()=> (req,res,next)=>{if(req.headers['x-test-role']){req.user={id:1,is_snt_super:req.headers['x-test-role']==='owner'};next();}else res.sendStatus(401);});
const svc=require('../../src/licensing/authority.service');
const app=express();app.use(express.json());app.use('/api/licensing',require('../../src/licensing/authority.routes'));app.use(require('../../src/middleware/error.middleware'));
beforeEach(()=>{process.env.DEPLOYMENT_MODE='cloud';process.env.PHASE3_LICENSING_ENABLED='false';db.query.mockClear();});
afterEach(()=>{process.env.DEPLOYMENT_MODE='cloud';process.env.PHASE3_LICENSING_ENABLED='false';jest.restoreAllMocks();});
test('default disabled endpoints return 404 without authentication or database access',async()=>{
  for(const url of ['/api/licensing','/api/licensing/capabilities','/api/licensing/id/history'])await request(app).get(url).expect(404);
  await request(app).post('/api/licensing/lease').send({}).expect(404);expect(db.query).not.toHaveBeenCalled();
});
test('on-prem installation cannot issue licenses or reach owner controls',async()=>{process.env.DEPLOYMENT_MODE='on_prem';await request(app).get('/api/licensing/capabilities').set('x-test-role','owner').expect(404);});
test('enabled owner API requires server-authenticated SNT super admin',async()=>{
  process.env.PHASE3_LICENSING_ENABLED='true';await request(app).get('/api/licensing').expect(401);
  await request(app).get('/api/licensing').set('x-test-role','company_admin').expect(403);
  const res=await request(app).get('/api/licensing/capabilities').set('x-test-role','owner').expect(200);expect(res.body).toEqual({enabled:true,authority:true});expect(res.headers['cache-control']).toBe('no-store');
});
test('lease endpoint does not accept a credential in the query string',async()=>{
  process.env.PHASE3_LICENSING_ENABLED='true';const spy=jest.spyOn(svc,'lease').mockRejectedValue(Object.assign(new Error('invalid'),{status:401}));
  await request(app).post('/api/licensing/lease?token=secret').send({}).expect(401);expect(spy.mock.calls[0][1]).toBeUndefined();
});
