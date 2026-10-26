const crypto = require('node:crypto');
const { issueLease, verifyLease } = require('../../src/licensing/lease');
const { createRuntime } = require('../../src/licensing/runtime');
const config = require('../../src/licensing/config');
const db = require('../../src/db');
const authority = require('../../src/licensing/authority.service');
const keys = crypto.generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
const id = 'bd94a13d-4e6d-4619-849b-2506638dc247';
const install = '52d85caf-2703-4cec-9d73-408083720c47';
const boot = 'a08181bf-adf0-4528-b226-e63d6cbda1c1';
const nonce = 'ab'.repeat(32);
const claims = (patch = {}) => { const now = Math.floor(Date.now() / 1000); return { v: 1, deployment_mode: 'on_prem', company_id: 4,
  installation_id: install, boot_id: boot, license_id: id, max_machines: 10, revision: 1, iat: now, exp: now + 120, license_exp: now + 86400, nonce, ...patch }; };
const options = { companyId: 4, installationId: install, bootId: boot, nonce };
const record = patch => ({ id, installation_id: install, company_id: 4, name: 'Factory', deployment_mode: 'cloud', max_machines: 10,
  expires_at: new Date(Date.now() + 86400000).toISOString(), status: 'active', revision: 1, company_active: true, plan_active: true,
  plan_expires_at: null, plan_max_machines: 20, active_machines: 6, activation_token_hash: 'a'.repeat(64), ...patch });

afterEach(() => jest.restoreAllMocks());
describe('signed installation leases', () => {
  test('valid signed lease preserves its company, installation and ten-machine allowance', () => {
    const value = claims(); expect(verifyLease(issueLease(value, privateKey), publicKey, options)).toEqual(value);
  });
  test.each(['company', 'installation', 'boot', 'nonce', 'key', 'payload', 'expired', 'long', 'malformed'])('rejects %s substitution or replay', variant => {
    const value = claims(), opts = { ...options }; let key = publicKey, signed = issueLease(value, privateKey);
    if (variant === 'company') opts.companyId = 5;
    if (variant === 'installation') opts.installationId = crypto.randomUUID();
    if (variant === 'boot') opts.bootId = crypto.randomUUID();
    if (variant === 'nonce') opts.nonce = 'cd'.repeat(32);
    if (variant === 'key') key = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
    if (variant === 'payload') { const parts = signed.split('.'); parts[1] = Buffer.from(JSON.stringify({ ...value, max_machines: 999 })).toString('base64url'); signed = parts.join('.'); }
    if (variant === 'expired') opts.now = Date.now() + 121000;
    if (variant === 'long') signed = 'a'.repeat(5000);
    if (variant === 'malformed') signed = 'not.a.signature';
    expect(() => verifyLease(signed, key, opts)).toThrow('invalid or expired');
  });
  test.each([{max_machines:0},{max_machines:10.5},{exp:Math.floor(Date.now()/1000)+181},{deployment_mode:'cloud'},{revision:0}])('refuses unsafe signed claims %j', patch => {
    expect(() => issueLease(claims(patch), privateKey)).toThrow();
  });
});

function edge() {
  let wall = Date.now(), mono = 0, count = 6;
  const database = { query: jest.fn(async () => ({ rows: [{ n: count }] })) };
  const fetcher = jest.fn(async (_url, init) => {
    const sent = JSON.parse(init.body);
    const value = claims({ nonce: sent.nonce, boot_id: sent.boot_id });
    return new Response(JSON.stringify({ lease: issueLease(value, privateKey) }), { status: 200 });
  });
  const env = { DEPLOYMENT_MODE: 'on_prem', PHASE3_LICENSING_ENABLED: 'false', LICENSE_SERVER_URL: 'https://license.example.test/api/licensing/lease',
    LICENSE_COMPANY_ID: '4', LICENSE_INSTALLATION_ID: install, LICENSE_ACTIVATION_TOKEN_FILE: 'token', LICENSE_VERIFY_KEY_FILE: 'public' };
  const runtime = createRuntime({ env, db: database, fetcher, now: () => wall, monotonic: () => mono,
    readFile: file => file === 'public' ? publicKey : 'mxl_' + 'a'.repeat(43) });
  return { runtime, fetcher, database, env, clock: (w, m) => { wall += w; mono += m; }, count: n => { count = n; } };
}
describe('runtime enforcement and load bounds', () => {
  test('Phase 3 default off does no DB, network or authority work', async () => {
    const database = {query:jest.fn()}, fetcher=jest.fn(), get=jest.fn();
    const runtime=createRuntime({env:{},db:database,fetcher,authority:()=>({getCompanyEntitlement:get})});
    await runtime.start();await runtime.refresh();await runtime.assertAccess({company_id:4});await runtime.assertMachineSlot(4,database);
    expect(database.query).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();
  });
  test('on-prem mode cannot use the false release flag to bypass licensing', async () => {
    const e=edge();expect(config.enabled(e.env)).toBe(true);await expect(e.runtime.assertAccess({company_id:4})).rejects.toMatchObject({code:'LICENSE_UNAVAILABLE'});
  });
  test('one shared installation check supports many users without per-request network work', async () => {
    const e=edge();await Promise.all(Array.from({length:100},()=>e.runtime.refresh()));
    await Promise.all(Array.from({length:200},()=>e.runtime.assertAccess({company_id:4})));
    expect(e.fetcher).toHaveBeenCalledTimes(1);expect(e.database.query).toHaveBeenCalledTimes(1);
    expect(e.fetcher.mock.calls[0][1].redirect).toBe('error');expect(e.runtime.ready()).toBe(true);
  });
  test('company mismatch, failed internet check and expired lease each fail closed', async () => {
    const e=edge();await e.runtime.refresh();await expect(e.runtime.assertAccess({company_id:5})).rejects.toMatchObject({code:'LICENSE_COMPANY'});
    e.fetcher.mockRejectedValueOnce(new Error('network down'));await e.runtime.refresh();expect(e.runtime.ready()).toBe(false);
    await expect(e.runtime.assertAccess({company_id:4})).rejects.toMatchObject({code:'LICENSE_UNAVAILABLE'});
    await e.runtime.refresh();e.clock(121000,121000);await expect(e.runtime.assertAccess({company_id:4})).rejects.toMatchObject({code:'LICENSE_UNAVAILABLE'});
  });
  test('rolling the server clock back cannot extend an accepted lease', async () => {
    const e=edge();await e.runtime.refresh();e.clock(-60000,61000);expect(e.runtime.ready()).toBe(false);
  });
  test('the eleventh active machine is refused inside the existing transaction', async () => {
    const e=edge();await e.runtime.refresh();e.count(10);await expect(e.runtime.assertMachineSlot(4,e.database)).rejects.toMatchObject({code:'LICENSE_MACHINE_LIMIT'});
    e.count(9);await expect(e.runtime.assertMachineSlot(4,e.database)).resolves.toBeUndefined();
  });
  test('an over-limit installation receives no access', async () => {
    const e=edge();e.count(11);await e.runtime.refresh();expect(e.runtime.ready()).toBe(false);
  });
  test.each(['http://license.example.test/api/licensing/lease','https://secret@license.example.test/api/licensing/lease','https://license.example.test/api/licensing/lease?token=secret'])('refuses unsafe authority URL %s', async url => {
    const e=edge();e.env.LICENSE_SERVER_URL=url;await expect(e.runtime.start()).rejects.toMatchObject({code:'LICENSE_CONFIGURATION'});expect(e.fetcher).not.toHaveBeenCalled();
  });
  test('cloud requests coalesce per company and respect absolute expiry even inside cache TTL', async () => {
    const get=jest.fn(async company_id=>({company_id,deployment_mode:'cloud',expires_at:new Date(Date.now()+1000).toISOString(),max_machines:10}));let now=Date.now();
    const runtime=createRuntime({env:{PHASE3_LICENSING_ENABLED:'true'},now:()=>now,authority:()=>({getCompanyEntitlement:get})});
    await Promise.all(Array.from({length:200},()=>runtime.assertAccess({company_id:4})));expect(get).toHaveBeenCalledTimes(1);
    now+=1100;await expect(runtime.assertAccess({company_id:4})).rejects.toMatchObject({code:'LICENSE_EXPIRED'});
    expect(get).toHaveBeenCalledTimes(2);
  });
  test('cloud explicitly enrolled on-prem company cannot bypass its installation through cloud login', async () => {
    const runtime=createRuntime({env:{PHASE3_LICENSING_ENABLED:'true'},authority:()=>({getCompanyEntitlement:async()=>({deployment_mode:'on_prem',expires_at:new Date(Date.now()+10000).toISOString()})})});
    await expect(runtime.assertAccess({company_id:4})).rejects.toMatchObject({code:'LICENSE_DEPLOYMENT'});
    await expect(runtime.assertAccess({company_id:null,is_snt_super:true})).resolves.toBeNull();
  });
  test('a slow cloud lookup remains single-flight even after the cache TTL passes',async()=>{
    let finish,now=Date.now();const get=jest.fn(()=>new Promise(resolve=>{finish=resolve;}));
    const runtime=createRuntime({env:{PHASE3_LICENSING_ENABLED:'true'},now:()=>now,authority:()=>({getCompanyEntitlement:get})});
    const first=runtime.assertAccess({company_id:4});now+=10000;const second=runtime.assertAccess({company_id:4});
    expect(get).toHaveBeenCalledTimes(1);finish(null);await Promise.all([first,second]);
  });
  test('a renewal reply arriving after shutdown cannot reopen the installation',async()=>{
    const e=edge();let finish;const original=e.fetcher.getMockImplementation();e.fetcher.mockImplementation((...args)=>new Promise(resolve=>{finish=()=>resolve(original(...args));}));
    const pending=e.runtime.refresh();await Promise.resolve();e.runtime.stop();finish();await pending;expect(e.runtime.ready()).toBe(false);
  });
});

describe('owner authority entitlement and audit', () => {
  beforeEach(()=>db.query.mockReset());
  test.each([{status:'revoked'},{status:'suspended'},{expires_at:new Date(0).toISOString()},{plan_active:false},{company_active:false},{active_machines:11},{plan_max_machines:0}])('blocks entitlement %j', async patch => {
    db.query.mockResolvedValue({rows:[record(patch)]});await expect(authority.getCompanyEntitlement(4)).rejects.toMatchObject({status:403});
  });
  test('effective cap and expiry respect the company plan; unenrolled legacy companies are unchanged', async () => {
    db.query.mockResolvedValueOnce({rows:[record({plan_max_machines:8})]}).mockResolvedValueOnce({rows:[]});
    expect((await authority.getCompanyEntitlement(4)).max_machines).toBe(8);expect(await authority.getCompanyEntitlement(5)).toBeNull();
  });
  test('create stores only a hash, records a redacted audit event and returns credential once', async () => {
    const client={query:jest.fn(async(sql,params)=>{
      if(sql.startsWith('SELECT id FROM companies'))return {rows:[{id:4}]};
      if(sql.includes('INSERT INTO deployment_licenses'))return {rows:[record({id:params[0],installation_id:params[1],activation_token_hash:params[7]})]};
      return {rows:[]};
    }),release:jest.fn()};db.connect.mockResolvedValue(client);
    const result=await authority.create({company_id:4,name:'Factory',deployment_mode:'on_prem',expires_at:new Date(Date.now()+86400000).toISOString()},1);
    expect(result.activation_token).toMatch(/^mxl_/);expect(result.license.activation_token_hash).toBeUndefined();
    const insert=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO deployment_licenses'));
    expect(insert[1][7]).toBe(authority.hashToken(result.activation_token));
    const audit=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO deployment_license_events'));
    expect(audit[1][4]).not.toContain('activation_token');expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');expect(client.release).toHaveBeenCalled();
  });
  test.each([0,-1,1.5,'10',100001])('rejects invalid machine allowance %s before mutation', async max_machines => {
    await expect(authority.create({company_id:4,name:'Factory',deployment_mode:'cloud',max_machines,expires_at:new Date(Date.now()+10000).toISOString()},1)).rejects.toMatchObject({status:400});
  });
  test('revocation cannot be reversed and failed changes roll back', async () => {
    const client={query:jest.fn(async sql=>({rows:sql.startsWith('SELECT *')?[record({status:'revoked'})]:[]})),release:jest.fn()};db.connect.mockResolvedValue(client);
    await expect(authority.update(id,{status:'active'},1)).rejects.toMatchObject({code:'LICENSE_REVOKED'});
    expect(client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
});
