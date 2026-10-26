#!/usr/bin/env node
// Integration proof against a NEW, throwaway local PostgreSQL cluster only.
// This script never reads .env and never accepts a production connection URL.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
const {Pool}=require('pg');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'mexa-phase3-pg-')),data=path.join(base,'data'),socket=path.join(base,'socket');
fs.mkdirSync(socket);let pool,started=false;
function command(binary,args){const result=spawnSync(binary,args,{encoding:'utf8'});if(result.status!==0)throw Error(`${binary} failed: ${result.stderr}`);}
async function main(){
  command('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust']);
  // Unix socket only: no TCP listener or shared database is used.
  command('pg_ctl',['-D',data,'-l',path.join(base,'postgres.log'),'-o',`-k ${socket} -h '' -p 55489`,'-w','start']);started=true;
  pool=new Pool({host:socket,port:55489,database:'postgres',user:os.userInfo().username,max:4});
  const dbPath=require.resolve('../../src/db');require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:pool};
  process.env.DEPLOYMENT_MODE='cloud';process.env.PHASE3_LICENSING_ENABLED='false';
  await pool.query(`CREATE TABLE companies(id INT PRIMARY KEY,company_name TEXT,is_active BOOLEAN DEFAULT TRUE);
    CREATE TABLE plans(id INT PRIMARY KEY,max_machines INT);
    CREATE TABLE company_plans(company_id INT PRIMARY KEY,plan_id INT,max_machines INT,expires_at TIMESTAMPTZ,is_active BOOLEAN DEFAULT TRUE);
    CREATE TABLE machines(id SERIAL PRIMARY KEY,company_id INT,is_active BOOLEAN DEFAULT TRUE);
    INSERT INTO companies VALUES(4,'Cloud fixture',TRUE),(5,'Factory fixture',TRUE);
    INSERT INTO plans VALUES(1,20);INSERT INTO company_plans(company_id,plan_id) VALUES(4,1),(5,1);
    INSERT INTO machines(company_id) SELECT 4 FROM generate_series(1,10);
    INSERT INTO machines(company_id) SELECT 5 FROM generate_series(1,3);`);
  await pool.query(fs.readFileSync(path.join(__dirname,'../../src/migrations/061_deployment_licensing.sql'),'utf8'));
  const authority=require('../../src/licensing/authority.service');
  const expiry=new Date(Date.now()+86400000).toISOString();
  const cloud=await authority.create({company_id:4,name:'Cloud fixture',deployment_mode:'cloud',max_machines:10,expires_at:expiry,payment_reference:'synthetic-payment'},1);
  assert.equal((await authority.getCompanyEntitlement(4)).max_machines,10);
  assert.equal((await authority.list())[0].activation_token_hash,undefined);
  await assert.rejects(authority.create({company_id:4,name:'Duplicate',deployment_mode:'cloud',expires_at:expiry},1),e=>e.status===409);
  const {createRuntime}=require('../../src/licensing/runtime');
  const cloudRuntime=createRuntime({env:{DEPLOYMENT_MODE:'cloud',PHASE3_LICENSING_ENABLED:'true'},db:pool});
  const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query('SELECT id FROM companies WHERE id=4 FOR UPDATE');await assert.rejects(cloudRuntime.assertMachineSlot(4,tx),e=>e.code==='LICENSE_MACHINE_LIMIT');await tx.query('ROLLBACK');}finally{tx.release();}
  await authority.update(cloud.license.id,{max_machines:11,note:'Approved allowance change'},1);
  cloudRuntime.invalidate(4);assert.equal((await cloudRuntime.assertAccess({company_id:4})).max_machines,11);
  await pool.query('INSERT INTO machines(company_id) VALUES(4),(4)');
  await assert.rejects(authority.getCompanyEntitlement(4),e=>e.code==='LICENSE_MACHINE_LIMIT');
  const factory=await authority.create({company_id:5,name:'On-prem fixture',deployment_mode:'on_prem',max_machines:10,expires_at:expiry},1);
  const keys=crypto.generateKeyPairSync('ed25519');const privateFile=path.join(base,'test-private.pem');
  fs.writeFileSync(privateFile,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});process.env.LICENSE_SIGNING_KEY_FILE=privateFile;
  const pub=keys.publicKey.export({format:'pem',type:'spki'});
  let currentToken=factory.activation_token;
  const edge=createRuntime({env:{DEPLOYMENT_MODE:'on_prem',LICENSE_SERVER_URL:'https://authority.example.test/api/licensing/lease',LICENSE_COMPANY_ID:'5',LICENSE_INSTALLATION_ID:factory.installation_id,LICENSE_ACTIVATION_TOKEN_FILE:'token',LICENSE_VERIFY_KEY_FILE:'public'},db:pool,
    readFile:file=>file==='public'?pub:currentToken,
    fetcher:async(_url,init)=>new Response(JSON.stringify(await authority.lease(JSON.parse(init.body),init.headers.Authorization.slice(7))))});
  await edge.refresh();assert.equal(edge.ready(),true);assert.equal((await edge.assertAccess({company_id:5})).max_machines,10);
  const copiedRequest={installation_id:factory.installation_id,boot_id:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),active_machines:3};
  await assert.rejects(authority.lease(copiedRequest,factory.activation_token),e=>e.code==='LICENSE_INSTANCE_ACTIVE');
  const rotated=await authority.rotateToken(factory.license.id,1);
  await assert.rejects(authority.lease(copiedRequest,factory.activation_token),e=>e.status===401);
  edge.stop();currentToken=rotated.activation_token;await edge.refresh();assert.equal(edge.ready(),true);
  await authority.update(factory.license.id,{status:'suspended'},1);await edge.refresh();assert.equal(edge.ready(),false);
  await authority.update(factory.license.id,{status:'active'},1);await edge.refresh();assert.equal(edge.ready(),true);
  await pool.query("UPDATE deployment_licenses SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[factory.license.id]);await edge.refresh();assert.equal(edge.ready(),false);
  await authority.update(factory.license.id,{expires_at:new Date(Date.now()+172800000).toISOString(),payment_reference:'synthetic-renewal'},1);await edge.refresh();assert.equal(edge.ready(),true);
  const events=await authority.history(factory.license.id);assert.equal(events.length,5);
  assert.ok(events.every(event=>!JSON.stringify(event).includes('activation_token')));
  await assert.rejects(pool.query("UPDATE deployment_license_events SET note='tampered' WHERE license_id=$1",[factory.license.id]),e=>e.code==='55000');
  await assert.rejects(pool.query('DELETE FROM deployment_license_events WHERE license_id=$1',[factory.license.id]),e=>e.code==='55000');
  edge.stop();cloudRuntime.stop();console.log('PASS: real PostgreSQL migration, ten-machine cap, owner updates, hash redaction, signed lease, token rotation, suspension/resume, expiry and immutable audit.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await pool?.end();if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);fs.rmSync(base,{recursive:true,force:true});});
