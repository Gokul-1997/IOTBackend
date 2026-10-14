/* Run only against a new private Unix-socket PostgreSQL cluster. No .env,
 * credentials, existing database, Redis service or controller is contacted. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const http = require('http');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const repository = path.resolve(__dirname, '../..');
const pgBin = process.env.AUTH_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-auth-fixture-'));
let running = false, pool, server, io;
const clients = [];
const migration = fs.readFileSync(path.join(repository, 'src/migrations/045_auth_revision.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(repository, 'src/migrations/rollback/045_auth_revision_down.sql'), 'utf8');
const schema = `
CREATE TABLE companies(id INT PRIMARY KEY, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE plants(id INT PRIMARY KEY, company_id INT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE users(id INT PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, plant_id INT,
  company_id INT, user_type TEXT DEFAULT 'company_user', is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE roles(id INT PRIMARY KEY, role_name TEXT, company_id INT, is_system BOOLEAN DEFAULT FALSE, updated_at TIMESTAMPTZ);
CREATE TABLE permissions(id INT PRIMARY KEY, permission_key TEXT);
CREATE TABLE user_roles(user_id INT REFERENCES users, role_id INT REFERENCES roles, PRIMARY KEY(user_id,role_id));
CREATE TABLE role_permissions(role_id INT REFERENCES roles, permission_id INT REFERENCES permissions, PRIMARY KEY(role_id,permission_id));
CREATE TABLE company_permissions(company_id INT REFERENCES companies, permission_id INT REFERENCES permissions, granted_by INT,
  PRIMARY KEY(company_id,permission_id));
INSERT INTO companies VALUES(4),(5);
INSERT INTO plants VALUES(11,4),(12,4);
INSERT INTO users(id,username,email,plant_id,company_id) VALUES(1,'quality','quality@test',11,4),(2,'other','other@test',NULL,5);
INSERT INTO roles VALUES(10,'QUALITY',4,FALSE,NULL),(20,'VIEWER',4,FALSE,NULL);
INSERT INTO permissions VALUES(1,'page:quality:view'),(2,'page:quality:edit');
INSERT INTO user_roles VALUES(1,10);
INSERT INTO role_permissions VALUES(10,1),(10,2),(20,1);
INSERT INTO company_permissions VALUES(4,1,NULL),(4,2,NULL);`;

function stub(relative, exports) {
  const filename = require.resolve(path.join(repository, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const nextEvent = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 3000);
  socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
});
async function token(revision) {
  const grants = await pool.query(`SELECT p.permission_key FROM permissions p
    JOIN role_permissions rp ON rp.permission_id=p.id JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=1`);
  return jwt.sign({ user_id: 1, company_id: 999, plant_id: 999, roles: ['QUALITY'],
    permissions: grants.rows.map(row => row.permission_key), ...(revision === undefined ? {} : { auth_revision: revision }) }, process.env.JWT_SECRET);
}

(async () => {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(directory, 'data'), '-U', 'cnc_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-o', `-F -k ${directory} -p 55445 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    pool = new Pool({ host: directory, port: 55445, user: 'cnc_fixture', database: 'postgres', max: 4 });
    await pool.query(schema); await pool.query(migration); await pool.query(migration);
    assert.equal((await pool.query('SELECT auth_revision FROM users WHERE id=1')).rows[0].auth_revision, '0');
    stub('src/db.js', pool);
    // Intentionally failing Redis proves cache cleanup does not control access
    // or make a successful transaction look as though it was rolled back.
    stub('src/redis.js', { get: async () => { throw new Error('fixture Redis down'); }, del: async () => { throw new Error('fixture Redis down'); } });
    // company.service imports the mail helper at module load. Stub it before
    // loading services so its dotenv/SMTP configuration is never consulted.
    stub('src/utils/nodemailer/index.js', { sendEmail: async () => {}, sendBulkEmails: async () => {} });
    process.env.JWT_SECRET = 'disposable-auth-fixture-secret';
    const auth = require(path.join(repository, 'src/middleware/auth.middleware.js'));
    const roles = require(path.join(repository, 'src/roles/role.service.js'));
    const users = require(path.join(repository, 'src/users/user.service.js'));
    const companies = require(path.join(repository, 'src/companies/company.service.js'));
    const readScope = require(path.join(repository, 'src/lib/read-scope.js'));
    const app = express();
    app.get('/private', auth, (req, res) => res.json({ user: req.user, scope: readScope.current() }));
    server = http.createServer(app); io = new Server(server);
    require(path.join(repository, 'src/lib/socket-server.js')).attach(io, { db: pool });
    require(path.join(repository, 'src/lib/realtime.js')).setIo(io);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async accessToken => {
      const response = await fetch(`${url}/private`, { headers: { Authorization: `Bearer ${accessToken}` } });
      return { status: response.status, body: await response.json() };
    };
    const oldToken = await token();
    const before = await request(oldToken);
    assert.equal(before.status, 200); assert.equal(before.body.user.company_id, 4); assert.equal(before.body.user.plant_id, 11);
    assert.deepEqual(before.body.scope, { companyId: 4, plantId: 11 });
    const socket = connect(url, { auth: { token: oldToken }, transports: ['websocket'], reconnection: false }); clients.push(socket);
    await nextEvent(socket, 'connect');
    const disconnected = nextEvent(socket, 'disconnect');
    const actor = { id: 99, company_id: 4, roles: ['COMPANY_ADMIN'] };
    await roles.assignPermissions(10, [1], actor);
    assert.equal((await disconnected)[0], 'io server disconnect');
    assert.equal((await pool.query('SELECT auth_revision FROM users WHERE id=1')).rows[0].auth_revision, '1');
    assert.equal((await pool.query('SELECT auth_revision FROM users WHERE id=2')).rows[0].auth_revision, '0', 'Other company untouched');
    assert.deepEqual((await request(oldToken)).body.code, 'AUTH_REVISION_CHANGED');
    const staleSocket = connect(url, { auth: { token: oldToken }, transports: ['websocket'], reconnection: false }); clients.push(staleSocket);
    const [error] = await nextEvent(staleSocket, 'connect_error');
    assert.equal(error.message, 'TOKEN_EXPIRED'); assert.equal(error.data.code, 'AUTH_REVISION_CHANGED');
    const firstNew = await token('1'); assert.equal((await request(firstNew)).status, 200);
    await pool.query(`CREATE FUNCTION refuse_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.auth_revision <> OLD.auth_revision THEN RAISE EXCEPTION 'injected revision failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER refuse_revision BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION refuse_revision();`);
    await assert.rejects(() => roles.assignPermissions(10, [1, 2], actor), /injected revision failure/);
    assert.equal((await pool.query('SELECT auth_revision FROM users WHERE id=1')).rows[0].auth_revision, '1');
    assert.deepEqual((await pool.query('SELECT permission_id FROM role_permissions WHERE role_id=10 ORDER BY permission_id')).rows.map(row => row.permission_id), [1], 'Grant writes rolled back with failed revision bump');
    assert.equal((await request(firstNew)).status, 200, 'Rolled-back change does not revoke valid token');
    await pool.query('DROP TRIGGER refuse_revision ON users');
    await users.update(1, actor, { plant_id: 12 });
    assert.equal((await request(firstNew)).body.code, 'AUTH_REVISION_CHANGED');
    const moved = await token('2'); assert.equal((await request(moved)).body.user.plant_id, 12);
    await roles.assign(1, [20], actor);
    assert.equal((await request(moved)).body.code, 'AUTH_REVISION_CHANGED');
    assert.equal((await pool.query('SELECT auth_revision FROM users WHERE id=1')).rows[0].auth_revision, '3');
    const changedRoles = await token('3');
    await companies.assignCompanyPermissions(4, [1], 99);
    assert.equal((await request(changedRoles)).body.code, 'AUTH_REVISION_CHANGED');
    await pool.query("UPDATE users SET auth_revision=9007199254740993 WHERE id=1");
    assert.equal((await request(await token('9007199254740993'))).status, 200);
    assert.equal((await request(await token('9007199254740992'))).body.code, 'AUTH_REVISION_CHANGED');
    const exact = await token('9007199254740993');
    await users.update(1, actor, { is_active: false }); assert.equal((await request(exact)).status, 403);
    await pool.query(rollback); await pool.query(rollback);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n, 2, 'Rollback preserves accounts');
    console.log('Authorization PostgreSQL/HTTP/Socket fixture passed: migration/reapply/rollback, legacy0, trusted scope/ALS, role/company/user mutation revocation, active socket teardown, stale handshake rejection, transaction rollback with grants intact, Redis failure independence and exact BIGINT revision comparison.');
  } finally {
    for (const socket of clients) socket.close();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
