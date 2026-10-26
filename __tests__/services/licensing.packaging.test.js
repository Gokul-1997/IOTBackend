const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {parse,validate,run}=require('../../tools/phase3/install.cjs');
const {allowed}=require('../../tools/phase3/prepare-context.cjs');
const {spawnSync}=require('node:child_process');
test.each(['Backend/.env','Backend/src/.env','Backend/.git/config','Backend/src/license.key','FrontendIOT/dist/app.js.map','FrontendIOT/src/app/test.spec.ts','pms-backend/node_modules/a.js','Backend/storage/client.csv'])('release context excludes %s',file=>expect(allowed(file)).toBe(false));
test.each(['Backend/src/licensing/runtime.js','FrontendIOT/src/app/app.routes.ts','pms-backend/src/lib/journal.js'])('release context includes runtime %s',file=>expect(allowed(file)).toBe(true));
test('installer parses literal settings without executing shell interpolation',()=>{expect(parse('A=literal\n# note\nB=https://host/path')).toEqual({A:'literal',B:'https://host/path'});for(const body of ['A=$(cat file)','A=`cat file`','A=$TOKEN','A=x\nA=y'])expect(()=>parse(body)).toThrow();});
test('installer refuses missing settings and never defaults to starting services',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mexa-install-test-'));try{expect(()=>run([dir])).toThrow();expect(()=>run([dir,'--start'])).toThrow();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('installer rejects writable credential files before reading configuration',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mexa-install-test-'));try{fs.writeFileSync(path.join(dir,'release.env'),'A=x',{mode:0o644});expect(()=>validate(dir)).toThrow('owner-only');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('installer rejects missing verified schema even with pinned images',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mexa-install-test-'));try{
    fs.mkdirSync(path.join(dir,'secrets'));for(const name of ['api.env','collector.env','secrets/installation-token'])fs.writeFileSync(path.join(dir,name),'',{mode:0o600});
    fs.writeFileSync(path.join(dir,'release.env'),['API_IMAGE','WEB_IMAGE','COLLECTOR_IMAGE'].map(key=>`${key}=registry.test/mexa@sha256:${'a'.repeat(64)}`).join('\n'),{mode:0o600});
    expect(()=>validate(dir)).toThrow('SCHEMA_VERIFIED');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a complete protected release passes validation, while starting still requires separate owner release approval',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mexa-install-valid-'));try{
    fs.mkdirSync(path.join(dir,'secrets'));
    const ca=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'test-only-ca-private.pem'),'-out',path.join(dir,'secrets/database-ca.pem'),'-days','1','-subj','/CN=Fixture CA'],{stdio:'ignore'});expect(ca.status).toBe(0);
    const pair=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(path.join(dir,'secrets/license-public-key.pem'),pair.publicKey.export({format:'pem',type:'spki'}));
    const write=(file,body)=>fs.writeFileSync(path.join(dir,file),body,{mode:0o600});
    write('secrets/installation-token','mxl_'+'a'.repeat(43));
    write('release.env',[...['API_IMAGE','WEB_IMAGE','COLLECTOR_IMAGE'].map(key=>`${key}=registry.test/mexa@sha256:${'a'.repeat(64)}`),'SCHEMA_VERIFIED=true','BACKUP_RESTORE_VERIFIED=true','PHASE3_RELEASE_APPROVED=false'].join('\n'));
    write('api.env',['DEPLOYMENT_MODE=on_prem','LICENSE_SERVER_URL=https://owner.test/api/licensing/lease','LICENSE_COMPANY_ID=4','LICENSE_INSTALLATION_ID=52d85caf-2703-4cec-9d73-408083720c47',`JWT_SECRET=${'a'.repeat(48)}`,'POSTGRESQL_HOST=db.internal','POSTGRESQL_USER=api_user','POSTGRESQL_PASSWORD=fixture-only','POSTGRESQL_DATABASE=iot','CORS_ORIGINS=https://factory.test','REDIS_URL=rediss://redis.internal:6380','DB_SSL=true'].join('\n'));
    write('collector.env','MQTT_URL=mqtts://broker.internal:8883\nMQTT_USER=fixture\nMQTT_PASS=fixture-only\nDB_SSL=true\nREDIS_TLS=true');
    expect(validate(dir).api.LICENSE_COMPANY_ID).toBe('4');expect(()=>run([dir])).not.toThrow();
    expect(()=>run([dir,'--start'])).toThrow('Phase 3 remains disabled');expect(()=>run([dir,'--start','--enable-phase3'])).toThrow('Phase 3 remains disabled');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
