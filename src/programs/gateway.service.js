/** Multi-machine controller work. MQTT telemetry remains independent. */
const db = require('../db');
const crypto = require('node:crypto');
const storage = require('./storage');
const token = require('./gateway-token');
const jobs = require('./jobs');
const {
  cleanProgramPath
} = require('./program-path');
const {
  effectivePlantId
} = require('../lib/plant-scope');
const {
  denialFor
} = require('../middleware/access.middleware');
const {
  EventEmitter
} = require('node:events');
const wake = new EventEmitter();
wake.setMaxListeners(0);
const OPEN = ['QUEUED', 'DELIVERED'];
const ACTIONS = ['SEND', 'RESTORE', 'BACKUP', 'LIST', 'FETCH'];
const CAPABILITY = {
  SEND: 'upload',
  RESTORE: 'restore',
  BACKUP: 'current_backup',
  LIST: 'list',
  FETCH: 'download'
};
const CAP_KEYS = ['list', 'upload', 'download', 'current_backup', 'restore'];
const fail = (message, code, status = 400) => Object.assign(new Error(message), {
  message,
  code,
  status
});
const id = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) throw fail('A valid record number is required.', 'BAD_ID');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw fail('A valid record number is required.', 'BAD_ID');
  return n;
};
const company = req => {
  if (!req.user?.company_id || req.user?.is_snt_super) throw fail('Choose a company account for Program Transfer.', 'COMPANY_REQUIRED', 403);
  return id(req.user.company_id);
};
const page = query => {
  const p = id(query?.page || 1),
    limit = Math.min(100, id(query?.limit || 20));
  if (!Number.isSafeInteger((p - 1) * limit)) throw fail('Page is too large.', 'BAD_PAGE');
  return {
    page: p,
    limit,
    offset: (p - 1) * limit
  };
};
const caps = value => Object.fromEntries(CAP_KEYS.map(key => [key, value?.[key] === true]));
const cleanPath = value => {
  const s = String(value || '').replace(/\\/g, '/');
  if (s.length > 255 || s.startsWith('/') || /[:\x00-\x1f\x7f]/.test(s) || s.split('/').some(x => x === '..' || x === '.')) throw fail('Choose a path inside the configured program directory.', 'BAD_REMOTE_PATH');
  return s.replace(/\/+$/, '');
};
const requestKey = req => {
  const key = String(req.headers?.['idempotency-key'] || '');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw fail('Send an Idempotency-Key containing 16–80 letters, digits, hyphens or underscores.', 'BAD_REQUEST_KEY');
  return key;
};
async function tx(work) {
  const client = await db.connect();
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    commitAttempted = true;
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // A connection failure while COMMIT is in flight does not prove that
    // PostgreSQL rolled back. Preserve any published file in that case.
    e.commitUncertain = commitAttempted;
    throw e;
  } finally {
    client.release();
  }
}
async function audit(client, {
  company_id,
  gateway_id = null,
  machine_id = null,
  job_id = null,
  file_id = null,
  actor_id = null,
  action,
  details = {}
}) {
  await client.query(`INSERT INTO program_gateway_events(company_id,gateway_id,machine_id,job_id,file_id,actor_id,action,details)VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [company_id, gateway_id, machine_id, job_id, file_id, actor_id, action, details]);
}
async function machineFor(client, machineId, user, lock = false) {
  const machine = id(machineId);
  const {
    rows
  } = await client.query(`SELECT m.*,p.plant_name FROM machines m LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id WHERE m.id=$1 AND m.company_id=$2 AND m.is_active=TRUE AND($3::int IS NULL OR m.plant_id=$3) ${lock ? 'FOR UPDATE OF m' : ''}`, [machine, user.company_id, effectivePlantId(user)]);
  if (!rows.length) throw fail('Machine not found in your company and plant.', 'MACHINE_NOT_FOUND', 404);
  if (lock) await client.query('SELECT pg_advisory_xact_lock(61427,$1)', [machine]);
  return rows[0];
}
async function gatewayFor(client, gatewayId, companyId, lock = '') {
  const {
    rows
  } = await client.query(`SELECT g.* FROM program_gateways g JOIN companies c ON c.id=g.company_id AND c.is_active=TRUE LEFT JOIN plants p ON p.id=g.plant_id AND p.company_id=g.company_id WHERE g.id=$1 AND g.company_id=$2 AND g.is_active=TRUE AND(g.plant_id IS NULL OR p.is_active=TRUE) ${lock}`, [gatewayId, companyId]);
  if (!rows.length) throw fail('Gateway is unavailable.', 'GATEWAY_UNAVAILABLE', 403);
  return rows[0];
}
async function authenticate(client, gateway, lock = 'FOR SHARE OF g') {
  const current = await gatewayFor(client, gateway.id, gateway.company_id, lock);
  if (!current.token_hash || current.token_version !== gateway.token_version) throw fail('Gateway token changed. Reconfigure this gateway.', 'GATEWAY_TOKEN_INVALID', 401);
  return current;
}
async function assignmentFor(client, machine) {
  const {
    rows
  } = await client.query(`SELECT a.*,g.name AS gateway_name,g.last_seen_at,g.token_hash,g.token_version,g.max_concurrency,g.is_active AS gateway_active,g.plant_id AS gateway_plant FROM program_gateway_assignments a JOIN program_gateways g ON g.id=a.gateway_id AND g.company_id=a.company_id WHERE a.machine_id=$1 AND a.company_id=$2`, [machine.id, machine.company_id]);
  const a = rows[0];
  if (a && a.gateway_plant !== null && a.gateway_plant !== machine.plant_id) throw fail('Gateway assignment no longer matches the machine plant.', 'ASSIGNMENT_CHANGED', 409);
  return a || null;
}
const JOB_SELECT = `SELECT j.*,f.size_bytes AS file_size,f.sha256 AS file_sha256,f.folder AS file_folder,f.stored_name AS file_stored_name,b.stored_name AS backup_stored_name,u.username AS requested_by_name FROM program_jobs j LEFT JOIN program_files f ON f.id=j.file_id AND f.company_id=j.company_id AND f.machine_id=j.machine_id LEFT JOIN program_files b ON b.id=j.backup_file_id LEFT JOIN users u ON u.id=j.requested_by`;
async function getJob(client, jobId) {
  const {
    rows
  } = await client.query(`${JOB_SELECT} WHERE j.id=$1`, [jobId]);
  return rows[0] || null;
}
function view(job) {
  if (!job) return null;
  const {
    lease_token,
    gateway_token_version,
    company_id,
    controller_ip,
    command_parameters,
    file_folder,
    ...safe
  } = job;
  return {
    ...jobs.view(safe),
    relative_path: command_parameters?.relative_path || '',
    configuration_version: job.configuration_version
  };
}
async function announce(job) {
  await jobs.announce({
    ...view(job),
    company_id: job.company_id
  }).catch(error => console.error('[gateway status]', error.message));
}
function gatewayView(g) {
  return {
    id: g.id,
    name: g.name,
    plant_id: g.plant_id,
    plant_name: g.plant_name || null,
    max_concurrency: g.max_concurrency,
    last_seen_at: g.last_seen_at,
    online: !!g.last_seen_at && Date.now() - new Date(g.last_seen_at).getTime() < 90000,
    token_prefix: g.token_prefix,
    has_token: !!g.token_hash,
    machine_count: Number(g.machine_count || 0)
  };
}
async function machineView(client, machine) {
  const a = Object.hasOwn(machine, '_assignment') ? machine._assignment : await assignmentFor(client, machine);
  return {
    id: machine.id,
    machine_serial_no: machine.machine_serial_no,
    plant_id: machine.plant_id,
    plant_name: machine.plant_name,
    program_path: a?.program_path || machine.program_path || null,
    controller_key: a?.controller_key || null,
    protocol: a?.protocol || null,
    configuration_version: a?.configuration_version || null,
    gateway: a ? {
      id: a.gateway_id,
      name: a.gateway_name,
      online: !!a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < 90000,
      last_seen_at: a.last_seen_at
    } : null,
    capabilities: caps(a?.capabilities),
    limitations: a?.limitations || ['Assign a gateway and configure a controller adapter.'],
    connection_ready: !!a && a.gateway_active && !!a.token_hash,
    controller_reported_at: a?.reported_at || null,
    current_program: a?.current_program || null
  };
}
exports.listMachines = async req => {
  company(req);
  const {
    rows
  } = await db.query(`SELECT m.id,m.company_id,m.plant_id,m.machine_serial_no,m.program_path,p.plant_name,row_to_json(a) AS assignment,
 g.name AS gateway_name,g.last_seen_at,g.token_hash,g.is_active AS gateway_active,g.plant_id AS gateway_plant
 FROM machines m LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id
 LEFT JOIN program_gateway_assignments a ON a.machine_id=m.id AND a.company_id=m.company_id
 LEFT JOIN program_gateways g ON g.id=a.gateway_id AND g.company_id=a.company_id
 WHERE m.company_id=$1 AND m.is_active=TRUE AND($2::int IS NULL OR m.plant_id=$2) ORDER BY m.machine_serial_no,m.id LIMIT 1000`, [req.user.company_id, effectivePlantId(req.user)]);
  return Promise.all(rows.map(m => machineView(db, {
    ...m,
    _assignment: m.assignment ? {
      ...m.assignment,
      gateway_name: m.gateway_name,
      last_seen_at: m.last_seen_at,
      token_hash: m.token_hash,
      gateway_active: m.gateway_active,
      gateway_plant: m.gateway_plant
    } : null
  })));
};
exports.listGateways = async req => {
  company(req);
  const {
    rows
  } = await db.query(`SELECT g.*,p.plant_name,(SELECT COUNT(*) FROM program_gateway_assignments a WHERE a.gateway_id=g.id) AS machine_count FROM program_gateways g LEFT JOIN plants p ON p.id=g.plant_id AND p.company_id=g.company_id WHERE g.company_id=$1 AND($2::int IS NULL OR g.plant_id=$2) ORDER BY g.name,g.id LIMIT 200`, [req.user.company_id, effectivePlantId(req.user)]);
  return rows.map(gatewayView);
};
exports.createGateway = async req => {
  const tenant = company(req),
    name = String(req.body?.name || '').trim(),
    plant = req.body?.plant_id == null ? null : id(req.body.plant_id),
    limit = Number(req.body?.max_concurrency ?? 2);
  if (!name || name.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 16) throw fail('Use a gateway name and concurrency between 1 and 16.', 'BAD_GATEWAY');
  if (effectivePlantId(req.user) !== null && plant !== effectivePlantId(req.user)) throw fail('Choose your own plant.', 'PLANT_SCOPE', 403);
  const generated = token.generate();
  const gateway = await tx(async client => {
    if (plant) {
      const {
        rows
      } = await client.query('SELECT id FROM plants WHERE id=$1 AND company_id=$2 AND is_active=TRUE FOR SHARE', [plant, tenant]);
      if (!rows.length) throw fail('Plant not found.', 'PLANT_NOT_FOUND', 404);
    }
    const {
      rows
    } = await client.query(`INSERT INTO program_gateways(company_id,plant_id,name,token_hash,token_prefix,max_concurrency,created_by)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *`, [tenant, plant, name, generated.hash, generated.prefix, limit, req.user.id]);
    await audit(client, {
      company_id: tenant,
      gateway_id: rows[0].id,
      actor_id: req.user.id,
      action: 'GATEWAY_CREATED',
      details: {
        name,
        plant_id: plant,
        max_concurrency: limit
      }
    });
    return rows[0];
  });
  return {
    gateway: gatewayView(gateway),
    token: generated.token
  };
};
async function changeToken(req, revoke) {
  const tenant = company(req),
    generated = revoke ? null : token.generate();
  const gateway = await tx(async client => {
    const g = await gatewayFor(client, id(req.params.gatewayId), tenant, 'FOR UPDATE OF g');
    if (effectivePlantId(req.user) !== null && g.plant_id !== effectivePlantId(req.user)) throw fail('Gateway not found.', 'GATEWAY_NOT_FOUND', 404);
    const busy = await client.query('SELECT id FROM program_jobs WHERE gateway_id=$1 AND status=ANY($2) LIMIT 1', [g.id, OPEN]);
    if (busy.rows.length) throw fail('Finish or reconcile gateway commands before changing its token.', 'COMMAND_PENDING', 409);
    const {
      rows
    } = await client.query('UPDATE program_gateways SET token_hash=$2,token_prefix=$3,token_version=token_version+1,updated_at=NOW() WHERE id=$1 RETURNING *', [g.id, generated?.hash || null, generated?.prefix || null]);
    await audit(client, {
      company_id: tenant,
      gateway_id: g.id,
      actor_id: req.user.id,
      action: revoke ? 'GATEWAY_TOKEN_REVOKED' : 'GATEWAY_TOKEN_ROTATED'
    });
    return rows[0];
  });
  return {
    gateway: gatewayView(gateway),
    ...(generated ? {
      token: generated.token
    } : {})
  };
}
exports.rotateGateway = req => changeToken(req, false);
exports.revokeGateway = req => changeToken(req, true);
exports.saveAssignment = async req => {
  company(req);
  const gatewayId = id(req.body?.gateway_id),
    path = cleanProgramPath(req.body?.program_path);
  if (!path) throw fail('Enter the machine program directory.', 'BAD_ASSIGNMENT');
  const machine = await tx(async client => {
    const g = await gatewayFor(client, gatewayId, req.user.company_id, 'FOR SHARE OF g');
    const m = await machineFor(client, req.params.machineId, req.user, true);
    const { rows: previous } = await client.query('SELECT protocol,controller_key FROM program_gateway_assignments WHERE machine_id=$1 AND company_id=$2', [m.id,m.company_id]);
    const protocol = String(req.body?.protocol ?? previous[0]?.protocol ?? 'embedded').toLowerCase();
    const key = String(req.body?.controller_key ?? previous[0]?.controller_key ?? `machine-${m.id}`).trim();
    if (!['embedded', 'ftp', 'ftps', 'sftp', 'focas', 'smb'].includes(protocol) || !/^[-A-Za-z0-9_.]{1,100}$/.test(key)) throw fail('Use a supported adapter and a valid local controller profile.', 'BAD_ASSIGNMENT');
    if (g.plant_id !== null && g.plant_id !== m.plant_id) throw fail('Gateway and machine must belong to the same plant.', 'PLANT_SCOPE', 403);
    const busy = await client.query('SELECT id FROM program_jobs WHERE machine_id=$1 AND status=ANY($2) LIMIT 1', [m.id, OPEN]);
    if (busy.rows.length) throw fail('Finish or reconcile this machine operation first.', 'COMMAND_PENDING', 409);
    await client.query(`INSERT INTO program_gateway_assignments(company_id,machine_id,gateway_id,controller_key,protocol,program_path,updated_by)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(machine_id) DO UPDATE SET gateway_id=EXCLUDED.gateway_id,controller_key=EXCLUDED.controller_key,protocol=EXCLUDED.protocol,program_path=EXCLUDED.program_path,configuration_version=program_gateway_assignments.configuration_version+1,capabilities='{}',limitations='["Gateway must verify the controller profile."]',reported_at=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [m.company_id, m.id, g.id, key, protocol, path, req.user.id]);
    await client.query('UPDATE machines SET program_path=$2 WHERE id=$1', [m.id, path]);
    await audit(client, {
      company_id: m.company_id,
      gateway_id: g.id,
      machine_id: m.id,
      actor_id: req.user.id,
      action: 'GATEWAY_ASSIGNED',
      details: {
        controller_key: key,
        protocol,
        program_path: path
      }
    });
    return machineView(client, m);
  });
  wake.emit(`g:${gatewayId}`);
  return {
    machine
  };
};
async function insertFile(client, machine, saved, {
  userId = null,
  gatewayId = null,
  jobId = null,
  kind = 'NEW',
  provenance = {},
  uploadRequestKey = null
} = {}) {
  const {
    rows
  } = await client.query(`INSERT INTO program_files(company_id,machine_id,folder,stored_name,program_name,kind,size_bytes,sha256,uploaded_by,gateway_id,job_id,provenance,upload_request_key)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)RETURNING *`, [machine.company_id, machine.id, saved.folder, saved.storedName, saved.programName, kind, saved.size, saved.sha256, userId, gatewayId, jobId, provenance, uploadRequestKey]);
  return rows[0];
}
exports.upload = async req => {
  company(req);
  const key = requestKey(req);
  if (!req.file?.path) throw fail('Choose a CNC program file.', 'NO_FILE');
  const machine = await machineFor(db, req.params.machineId, req.user);
  const saved = await storage.saveStream({
    machine,
    kind: 'NEW',
    programName: req.file.originalname,
    filename: req.file.path
  });
  let replay = false;
  try {
    const file = await tx(async client => {
      await machineFor(client, machine.id, req.user, true);
      const previous = await client.query('SELECT * FROM program_files WHERE company_id=$1 AND machine_id=$2 AND uploaded_by=$3 AND upload_request_key=$4', [machine.company_id, machine.id, req.user.id, key]);
      if (previous.rows.length) {
        replay = true;
        const prior = previous.rows[0];
        if (prior.deleted_at || prior.sha256 !== saved.sha256 || prior.program_name !== saved.programName) throw fail('This upload key already belongs to different file content.', 'REQUEST_CONFLICT', 409);
        return prior;
      }
      const f = await insertFile(client, machine, saved, {
        userId: req.user.id,
        uploadRequestKey: key
      });
      await audit(client, {
        company_id: machine.company_id,
        machine_id: machine.id,
        file_id: f.id,
        actor_id: req.user.id,
        action: 'PROGRAM_UPLOAD',
        details: {
          program_name: f.program_name,
          size_bytes: f.size_bytes,
          sha256: f.sha256
        }
      });
      return f;
    });
    if (replay) await storage.remove(saved.folder, saved.storedName);
    return {
      file
    };
  } catch (error) {
    if (!error.commitUncertain || replay) await storage.remove(saved.folder, saved.storedName).catch(() => {});
    throw error;
  }
};
async function fileFor(client, fileId, machine) {
  const {
    rows
  } = await client.query('SELECT * FROM program_files WHERE id=$1 AND company_id=$2 AND machine_id=$3 AND deleted_at IS NULL', [id(fileId), machine.company_id, machine.id]);
  if (!rows.length) throw fail('File not found for this machine.', 'FILE_NOT_FOUND', 404);
  return rows[0];
}
async function requireAction(req, action) {
  const key = action === 'LIST' ? 'page:programs:view' : ['SEND', 'RESTORE'].includes(action) ? 'page:programs:transfer' : 'page:programs:fetch';
  const denial = await denialFor(req.user, key);
  if (denial) throw fail('This operation is not allowed by your role and company grant.', denial === 'COMPANY' ? 'NOT_IN_PLAN' : 'FORBIDDEN', 403);
}
exports.createCommand = async (req, action) => {
  const tenant = company(req);
  await requireAction(req, action);
  if (!ACTIONS.includes(action)) throw fail('Unsupported operation.', 'BAD_ACTION');
  if (['SEND', 'RESTORE'].includes(action) && req.body?.confirm !== true) throw fail('Confirm this controller write before continuing.', 'CONFIRMATION_REQUIRED', 409);
  const key = requestKey(req),
    body = req.body || {};
  const relative = cleanPath(body.path);
  let made = false;
  const job = await tx(async client => {
    const initial = await machineFor(client, req.params.machineId, req.user);
    let a = await assignmentFor(client, initial);
    if (!a || !a.gateway_active || !a.token_hash) throw fail('Assign and activate a gateway before contacting this machine.', 'NO_GATEWAY', 409);
    const g = await gatewayFor(client, a.gateway_id, tenant, 'FOR SHARE OF g');
    const machine = await machineFor(client, req.params.machineId, req.user, true);
    const currentAssignment = await assignmentFor(client, machine);
    if (!currentAssignment || currentAssignment.gateway_id !== a.gateway_id || currentAssignment.configuration_version !== a.configuration_version) throw fail('Gateway configuration changed. Reload before continuing.', 'ASSIGNMENT_CHANGED', 409);
    a = currentAssignment;
    const previous = await client.query('SELECT id FROM program_jobs WHERE company_id=$1 AND machine_id=$2 AND requested_by=$3 AND request_key=$4', [tenant, machine.id, req.user.id, key]);
    if (previous.rows.length) {
      const p = await getJob(client, previous.rows[0].id);
      const sourceChanged = ['SEND', 'RESTORE'].includes(action) && String(p.file_id || '') !== String(body.file_id || '');
      const previousPath = p.action === 'FETCH'
        ? [p.command_parameters?.relative_path, p.program_name].filter(Boolean).join('/')
        : p.command_parameters?.relative_path || '';
      if (p.action !== action || sourceChanged || p.overwrite !== (body.overwrite === true) || previousPath !== relative) throw fail('This request key already belongs to another command.', 'REQUEST_CONFLICT', 409);
      return p;
    }
    if (!caps(a.capabilities)[CAPABILITY[action]]) throw fail(`The gateway has not verified support for ${CAPABILITY[action]} on this controller.`, 'UNSUPPORTED_CAPABILITY', 409);
    const busy = await client.query('SELECT id FROM program_jobs WHERE machine_id=$1 AND status=ANY($2) LIMIT 1', [machine.id, OPEN]);
    if (busy.rows.length) throw fail('Finish or reconcile the pending machine operation first.', 'COMMAND_PENDING', 409);
    let file = null,
      name = null,
      folder = relative;
    if (['SEND', 'RESTORE'].includes(action)) {
      file = await fileFor(client, body.file_id, machine);
      name = file.program_name;
      if (action === 'RESTORE' && file.kind !== 'BACKUP') throw fail('Choose a verified controller backup to restore.', 'NOT_A_BACKUP', 409);
    } else if (action === 'FETCH') {
      const parts = relative.split('/');
      name = storage.safeProgramName(parts.pop());
      folder = parts.join('/');
      if (!name) throw fail('Select a controller file.', 'NO_FILE');
    }
    const {
      rows
    } = await client.query(`INSERT INTO program_jobs(company_id,machine_id,machine_serial,action,program_name,file_id,overwrite,requested_by,program_path,protocol_version,request_key,gateway_id,configuration_version,command_parameters,expires_at,stage)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,3,$10,$11,$12,$13,NOW()+INTERVAL '24 hours','QUEUED')RETURNING id`, [tenant, machine.id, machine.machine_serial_no, action, name, file?.id || null, body.overwrite === true, req.user.id, a.program_path, key, g.id, a.configuration_version, {
      relative_path: folder,
      controller_key: a.controller_key,
      protocol: a.protocol,
      confirm: body.confirm === true
    }]);
    const created = await getJob(client, rows[0].id);
    await audit(client, {
      company_id: tenant,
      gateway_id: g.id,
      machine_id: machine.id,
      job_id: created.id,
      file_id: file?.id,
      actor_id: req.user.id,
      action: 'COMMAND_REQUESTED',
      details: {
        action,
        program_name: name,
        path: folder,
        overwrite: body.overwrite === true
      }
    });
    made = true;
    return created;
  });
  if (made) {
    wake.emit(`g:${job.gateway_id}`);
    await announce(job);
  }
  return {
    job: view(job)
  };
};
exports.status = async req => {
  company(req);
  const machine = await machineFor(db, req.params.machineId, req.user);
  await exports.expireStale({ machineId: machine.id });
  const description = await machineView(db, machine);
  const [recent, files] = await Promise.all([db.query(`${JOB_SELECT} WHERE j.machine_id=$1 AND j.company_id=$2 AND j.protocol_version=3 ORDER BY j.requested_at DESC,j.id DESC LIMIT 20`, [machine.id, machine.company_id]), db.query(`SELECT DISTINCT ON(kind) * FROM program_files WHERE machine_id=$1 AND company_id=$2 AND deleted_at IS NULL ORDER BY kind,created_at DESC,id DESC`, [machine.id, machine.company_id])]);
  return {
    machine: description,
    capabilities: description.capabilities,
    limitations: description.limitations,
    file: files.rows.find(f => f.kind === 'NEW') || null,
    backup: files.rows.find(f => f.kind === 'BACKUP') || null,
    jobs: recent.rows.map(view)
  };
};
exports.listFiles = async req => {
  company(req);
  const sort = req.query.sort === undefined ? 'date' : req.query.sort;
  const direction = req.query.direction === undefined ? 'desc' : req.query.direction;
  const columns = { name: 'program_name', size: 'size_bytes', date: 'created_at' };
  if (typeof sort !== 'string' || !Object.hasOwn(columns, sort)) throw fail('Choose name, size or date sorting.', 'BAD_SORT');
  if (!['asc', 'desc'].includes(direction)) throw fail('Choose ascending or descending sorting.', 'BAD_DIRECTION');
  // Only identifiers and directions from these allowlists enter the SQL. The
  // matching ID order makes paging deterministic when names, sizes or dates tie.
  const order = `${columns[sort]} ${direction.toUpperCase()},id ${direction.toUpperCase()}`;
  const machine = await machineFor(db, req.query.machine_id, req.user);
  const pagination = page(req.query),
    kind = req.query.kind ? String(req.query.kind).toUpperCase() : null,
    search = String(req.query.search || '').slice(0, 100);
  const params = [machine.company_id, machine.id, kind, search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null];
  const where = 'company_id=$1 AND machine_id=$2 AND deleted_at IS NULL AND($3::text IS NULL OR kind=$3) AND($4::text IS NULL OR program_name ILIKE $4)';
  const [data, count] = await Promise.all([db.query(`SELECT * FROM program_files WHERE ${where} ORDER BY ${order} LIMIT $5 OFFSET $6`, [...params, pagination.limit, pagination.offset]), db.query(`SELECT COUNT(*)::int AS total FROM program_files WHERE ${where}`, params)]);
  return {
    data: data.rows,
    total: count.rows[0].total,
    page: pagination.page,
    limit: pagination.limit
  };
};
exports.getFile = async req => {
  company(req);
  const {
    rows
  } = await db.query('SELECT machine_id FROM program_files WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL', [id(req.params.id), req.user.company_id]);
  if (!rows.length) throw fail('File not found.', 'FILE_NOT_FOUND', 404);
  const machine = await machineFor(db, rows[0].machine_id, req.user);
  const file = await fileFor(db, req.params.id, machine);
  if (!req.skipAudit) await tx(client => audit(client, {
    company_id: machine.company_id,
    machine_id: machine.id,
    file_id: file.id,
    actor_id: req.user.id,
    action: 'PROGRAM_DOWNLOAD',
    details: {
      sha256: file.sha256
    }
  }));
  return file;
};
exports.listJobs = async req => {
  company(req);
  const machine = await machineFor(db, req.query.machine_id, req.user),
    pagination = page(req.query);
  const status = String(req.query.status || '');
  if (status && !['open', 'QUEUED', 'DELIVERED', 'DONE', 'FAILED', 'CANCELLED'].includes(status)) throw fail('Unsupported status filter.', 'BAD_STATUS');
  const filter = status === 'open' ? " AND j.status IN('QUEUED','DELIVERED')" : status ? ' AND j.status=$3' : '';
  const values = [machine.company_id, machine.id, ...(status && status !== 'open' ? [status] : [])];
  const [data, count] = await Promise.all([db.query(`${JOB_SELECT} WHERE j.company_id=$1 AND j.machine_id=$2 AND j.protocol_version=3 ${filter} ORDER BY j.requested_at DESC,j.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pagination.limit, pagination.offset]), db.query(`SELECT COUNT(*)::int AS total FROM program_jobs j WHERE j.company_id=$1 AND j.machine_id=$2 AND j.protocol_version=3 ${filter}`, values)]);
  return {
    data: data.rows.map(view),
    total: count.rows[0].total,
    page: pagination.page,
    limit: pagination.limit
  };
};
exports.cancel = async req => {
  company(req);
  const job = await tx(async client => {
    const j = await getJob(client, id(req.params.id));
    if (!j || j.company_id !== req.user.company_id || j.protocol_version !== 3) throw fail('Command not found.', 'JOB_NOT_FOUND', 404);
    await requireAction(req, j.action);
    // Claims take the gateway lock before touching job/machine rows. Use
    // the same outer lock so cancel cannot hold a machine while a claim
    // holds its job and waits for that machine.
    await gatewayFor(client, j.gateway_id, j.company_id, 'FOR SHARE OF g');
    await machineFor(client, j.machine_id, req.user, true);
    const changed = await client.query("UPDATE program_jobs SET status='CANCELLED',stage='CANCELLED',finished_at=NOW(),message='Cancelled before gateway collection' WHERE id=$1 AND status='QUEUED' RETURNING id", [j.id]);
    if (!changed.rows.length) throw fail('Only a queued command can be cancelled. A collected command must finish or be reconciled.', 'JOB_NOT_OPEN', 409);
    await audit(client, {
      company_id: j.company_id,
      gateway_id: j.gateway_id,
      machine_id: j.machine_id,
      job_id: j.id,
      actor_id: req.user.id,
      action: 'COMMAND_CANCELLED'
    });
    return getJob(client, j.id);
  });
  await announce(job);
  return view(job);
};
exports.retry = async req => {
  company(req);
  const j = await getJob(db, id(req.params.id));
  if (!j || j.company_id !== req.user.company_id || j.protocol_version !== 3) throw fail('Command not found.', 'JOB_NOT_FOUND', 404);
  await machineFor(db, j.machine_id, req.user);
  if (!['FAILED', 'CANCELLED'].includes(j.status)) throw fail('Retry is available only after a completed failure or cancellation.', 'JOB_NOT_OPEN', 409);
  return exports.createCommand({
    ...req,
    params: {
      machineId: j.machine_id
    },
    body: {
      ...req.body,
      file_id: ['SEND', 'RESTORE'].includes(j.action) ? j.file_id : undefined,
      path: j.action === 'FETCH' ? [j.command_parameters?.relative_path, j.program_name].filter(Boolean).join('/') : j.command_parameters?.relative_path,
      overwrite: j.overwrite
    }
  }, j.action);
};
exports.gatewayConfig = async (gateway, body = {}) => tx(async client => {
  const g = await authenticate(client, gateway);
  const reports = body.machines || [];
  if (!Array.isArray(reports) || reports.length > 200) throw fail('Report at most 200 machine states at a time.', 'BAD_REPORT');
  for (const report of reports) {
    const limitations = Array.isArray(report.limitations) ? report.limitations.slice(0, 20).map(x => String(x).slice(0, 200)) : [];
    await client.query(`UPDATE program_gateway_assignments a SET capabilities=$4,limitations=$5,current_program=$6,controller_status=$7,reported_at=NOW()
   FROM machines m WHERE a.machine_id=$1 AND a.company_id=$2 AND a.gateway_id=$3 AND a.configuration_version=$8
    AND m.id=a.machine_id AND m.company_id=a.company_id AND m.is_active=TRUE AND($9::int IS NULL OR m.plant_id=$9)`, [id(report.id), g.company_id, g.id, caps(report.capabilities), JSON.stringify(limitations), report.current_program ? String(report.current_program).slice(0, 255) : null, String(report.controller_status || 'UNKNOWN').slice(0, 40), id(report.configuration_version), g.plant_id]);
  }
  const {
    rows
  } = await client.query(`SELECT a.machine_id AS id,m.machine_serial_no AS serial,a.controller_key,a.protocol,a.program_path,a.configuration_version
  FROM program_gateway_assignments a JOIN machines m ON m.id=a.machine_id AND m.company_id=a.company_id
  LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id WHERE a.gateway_id=$1 AND a.company_id=$2
  AND m.is_active=TRUE AND(m.plant_id IS NULL OR p.is_active=TRUE) AND($3::int IS NULL OR m.plant_id=$3) ORDER BY a.machine_id LIMIT 1000`, [g.id, g.company_id, g.plant_id]);
  await client.query('UPDATE program_gateways SET last_seen_at=NOW() WHERE id=$1', [g.id]);
  return {
    gateway: {
      id: g.id,
      company_id: g.company_id,
      plant_id: g.plant_id,
      max_concurrency: g.max_concurrency
    },
    machines: rows,
    server_time: new Date().toISOString()
  };
});
function descriptor(j) {
  return {
    id: Number(j.id),
    machine_id: j.machine_id,
    action: j.action,
    source: j.action === 'BACKUP' ? 'CURRENT_RUNNING' : null,
    program_path: j.program_path,
    relative_path: j.command_parameters?.relative_path || '',
    program_name: j.program_name,
    overwrite: j.overwrite,
    controller_key: j.command_parameters?.controller_key,
    protocol: j.command_parameters?.protocol,
    configuration_version: j.configuration_version,
    lease_token: j.lease_token,
    expires_at: j.expires_at,
    recovery_only: j.status === 'DELIVERED' && (j.error_code === 'WRITE_STATE_UNKNOWN' || new Date(j.expires_at).getTime() <= Date.now()),
    file: ['SEND', 'RESTORE'].includes(j.action) ? {
      size: j.file_size,
      sha256: j.file_sha256,
      url: `/api/gateway/v1/jobs/${j.id}/file`
    } : null
  };
}
async function claimOnce(gateway, body) {
  const active = body.active_job_ids || [];
  if (!Array.isArray(active) || active.length > 16 || active.some(x => !Number.isSafeInteger(x) || x < 1)) throw fail('active_job_ids must contain at most 16 command numbers.', 'BAD_ACTIVE_JOBS');
  const slots = Number(body.available_slots ?? 1);
  if (!Number.isInteger(slots) || slots < 0 || slots > 16) throw fail('available_slots must be between 0 and 16.', 'BAD_CAPACITY');
  let changed = false;
  const job = await tx(async client => {
    const g = await authenticate(client, gateway, 'FOR UPDATE OF g');
    if (!slots) return null;
    // A reconnect resumes its outstanding job. It never fabricates a new write.
    const outstanding = await client.query(`SELECT j.id FROM program_jobs j JOIN program_gateway_assignments a
    ON a.machine_id=j.machine_id AND a.company_id=j.company_id AND a.gateway_id=j.gateway_id AND a.configuration_version=j.configuration_version
   JOIN machines m ON m.id=j.machine_id AND m.company_id=j.company_id AND m.is_active=TRUE
   LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id
   WHERE j.gateway_id=$1 AND j.company_id=$2 AND j.protocol_version=3 AND j.status='DELIVERED' AND j.gateway_token_version=$3
    AND NOT(j.id=ANY($4::bigint[])) AND($5::int IS NULL OR m.plant_id=$5) AND(m.plant_id IS NULL OR p.is_active=TRUE)
   ORDER BY j.delivered_at,j.id LIMIT 1 FOR UPDATE OF j`, [g.id, g.company_id, g.token_version, active, g.plant_id]);
    if (outstanding.rows.length) return getJob(client, outstanding.rows[0].id);
    const count = await client.query("SELECT COUNT(*)::int AS total FROM program_jobs WHERE gateway_id=$1 AND protocol_version=3 AND status='DELIVERED'", [g.id]);
    if (count.rows[0].total >= g.max_concurrency) return null;
    const queued = await client.query(`SELECT j.id,j.machine_id FROM program_jobs j JOIN program_gateway_assignments a
    ON a.machine_id=j.machine_id AND a.company_id=j.company_id AND a.gateway_id=j.gateway_id AND a.configuration_version=j.configuration_version
   JOIN machines m ON m.id=j.machine_id AND m.company_id=j.company_id AND m.is_active=TRUE
   LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id
   WHERE j.gateway_id=$1 AND j.company_id=$2 AND j.protocol_version=3 AND j.status='QUEUED' AND j.expires_at>NOW()
    AND($3::int IS NULL OR m.plant_id=$3) AND(m.plant_id IS NULL OR p.is_active=TRUE)
   ORDER BY j.requested_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [g.id, g.company_id, g.plant_id]);
    if (!queued.rows.length) return null;
    await client.query('SELECT id FROM machines WHERE id=$1 FOR UPDATE', [queued.rows[0].machine_id]);
    await client.query('SELECT pg_advisory_xact_lock(61427,$1)', [queued.rows[0].machine_id]);
    await client.query(`UPDATE program_jobs SET status='DELIVERED',stage='ACCEPTED',delivered_at=NOW(),lease_token=$2,gateway_token_version=$3,expires_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, [queued.rows[0].id, crypto.randomBytes(32).toString('hex'), g.token_version]);
    await audit(client, {
      company_id: g.company_id,
      gateway_id: g.id,
      machine_id: queued.rows[0].machine_id,
      job_id: queued.rows[0].id,
      action: 'COMMAND_CLAIMED'
    });
    changed = true;
    return getJob(client, queued.rows[0].id);
  });
  if (changed) await announce(job);
  return job;
}
exports.claim = async (gateway, body = {}, signal) => {
  const wait = Number(body.wait_seconds ?? 0);
  if (!Number.isInteger(wait) || wait < 0 || wait > 24) throw fail('wait_seconds must be between 0 and 24.', 'BAD_WAIT');
  if (!signal?.aborted) await exports.expireStale({ gatewayId: gateway.id });
  const started = Date.now();
  let job;
  do {
    if (signal?.aborted) return {
      job: null,
      poll_seconds: 15
    };
    job = await claimOnce(gateway, body);
    if (job) return {
      job: descriptor(job),
      poll_seconds: 15
    };
    const remaining = wait * 1000 - (Date.now() - started);
    if (remaining <= 0) break;
    // Process-local events wake immediately. A bounded database recheck also
    // works across API instances, without adding a broker or a pool connection.
    await new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        wake.removeListener(`g:${gateway.id}`, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      wake.once(`g:${gateway.id}`, done);
      signal?.addEventListener('abort', done, {
        once: true
      });
      timer = setTimeout(done, Math.min(remaining, 3000));
      if (signal?.aborted) done();
    });
  } while (Date.now() - started < wait * 1000);
  return {
    job: null,
    poll_seconds: 15
  };
};
/** A dead gateway cannot collect its own timeout. The cron, status endpoint
 * and next-command endpoint all run this bounded, retry-safe sweep.
 * A controller write with an unknown outcome deliberately keeps its lock. */
exports.expireStale = async ({ batchSize = 100, gatewayId = null, machineId = null } = {}) => {
  const limit = Math.min(500, id(batchSize));
  if (gatewayId !== null) gatewayId = id(gatewayId);
  if (machineId !== null) machineId = id(machineId);
  const changed = await tx(async client => {
    const { rows } = await client.query(`SELECT j.id,j.company_id,j.machine_id,j.gateway_id,j.action,j.status
      FROM program_jobs j WHERE j.protocol_version=3 AND j.status IN('QUEUED','DELIVERED') AND j.expires_at<=NOW()
        AND ($1::int IS NULL OR j.gateway_id=$1) AND ($2::int IS NULL OR j.machine_id=$2)
        AND NOT(j.status='DELIVERED' AND j.action IN('SEND','RESTORE') AND j.error_code IS NOT DISTINCT FROM 'WRITE_STATE_UNKNOWN')
      ORDER BY j.expires_at,j.id LIMIT $3 FOR UPDATE OF j SKIP LOCKED`, [gatewayId,machineId,limit]);
    const output = [];
    for (const j of rows) {
      const unknown = j.status === 'DELIVERED' && ['SEND','RESTORE'].includes(j.action);
      const queued = j.status === 'QUEUED';
      if (unknown) await client.query(`UPDATE program_jobs SET stage='NEEDS_RECONCILIATION',error_code='WRITE_STATE_UNKNOWN',
        message='Controller write outcome is unknown. The gateway must verify controller contents before any retry.' WHERE id=$1`, [j.id]);
      else await client.query(`UPDATE program_jobs SET status='FAILED',stage='FAILED',finished_at=NOW(),error_code=$2,message=$3 WHERE id=$1`,
        [j.id,queued ? 'QUEUE_TIMEOUT' : 'GATEWAY_TIMEOUT',queued
          ? 'No gateway collected this command within 24 hours.'
          : 'The gateway did not confirm completion within its lease. No controller write was requested.']);
      await audit(client, {
        company_id:j.company_id,gateway_id:j.gateway_id,machine_id:j.machine_id,job_id:j.id,
        action:unknown ? 'WRITE_RECONCILIATION_REQUIRED' : queued ? 'COMMAND_QUEUE_EXPIRED' : 'COMMAND_TIMEOUT'
      });
      output.push(await getJob(client,j.id));
    }
    return output;
  });
  for (const job of changed) await announce(job);
  return changed.length;
};
async function ownedJob(client, gateway, jobId, lease, {
  allowTerminal = false,
  allowExpired = false
} = {}) {
  const g = await authenticate(client, gateway);
  const {
    rows
  } = await client.query('SELECT id FROM program_jobs WHERE id=$1 AND gateway_id=$2 AND company_id=$3 AND protocol_version=3 FOR UPDATE', [id(jobId), g.id, g.company_id]);
  if (!rows.length) throw fail('Command not found for this gateway.', 'JOB_NOT_FOUND', 404);
  const j = await getJob(client, jobId);
  if (!lease || lease !== j.lease_token || j.gateway_token_version !== g.token_version) throw fail('Command lease does not belong to this gateway session.', 'LEASE_INVALID', 403);
  const {
    rows: assignments
  } = await client.query(`SELECT a.machine_id FROM program_gateway_assignments a JOIN machines m ON m.id=a.machine_id AND m.company_id=a.company_id AND m.is_active=TRUE LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id WHERE a.company_id=$1 AND a.machine_id=$2 AND a.gateway_id=$3 AND a.configuration_version=$4 AND($5::int IS NULL OR m.plant_id=$5) AND(m.plant_id IS NULL OR p.is_active=TRUE)`, [g.company_id, j.machine_id, g.id, j.configuration_version, g.plant_id]);
  if (!assignments.length) throw fail('The machine assignment changed or is inactive.', 'ASSIGNMENT_CHANGED', 409);
  if (!allowTerminal && j.status !== 'DELIVERED') throw fail('This command is no longer active.', 'JOB_NOT_OPEN', 409);
  if (!allowExpired && new Date(j.expires_at).getTime() <= Date.now()) throw fail('The lease expired. Reconcile the controller before completing this command.', 'LEASE_EXPIRED', 409);
  return j;
}
exports.progress = async (gateway, jobId, body = {}) => {
  const stage = String(body.stage || '');
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(stage) || ['DONE', 'FAILED', 'CANCELLED', 'QUEUED'].includes(stage)) throw fail('Use a nonterminal uppercase progress stage.', 'BAD_PROGRESS');
  const bytes = Number(body.bytes ?? 0),
    total = body.total == null ? null : Number(body.total);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > storage.MAX_BYTES || total !== null && (!Number.isSafeInteger(total) || total < bytes || total > storage.MAX_BYTES)) throw fail('Invalid transfer byte counts.', 'BAD_PROGRESS');
  const job = await tx(async client => {
    const j = await ownedJob(client, gateway, jobId, body.lease_token);
    if (j.error_code === 'WRITE_STATE_UNKNOWN' && stage !== 'RECONCILING') throw fail('Verify the controller outcome before resuming this command.', 'WRITE_RECONCILIATION_REQUIRED', 409);
    if (stage === j.stage && bytes < Number(j.progress_bytes)) throw fail('Transfer progress cannot move backwards within a stage.', 'BAD_PROGRESS');
    await client.query(`UPDATE program_jobs SET stage=$2,progress_bytes=$3,progress_total=$4,progress_at=NOW(),expires_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, [j.id, stage, bytes, total]);
    await audit(client, {
      company_id: j.company_id,
      gateway_id: j.gateway_id,
      machine_id: j.machine_id,
      job_id: j.id,
      action: 'COMMAND_PROGRESS',
      details: {
        stage,
        bytes,
        total
      }
    });
    return getJob(client, j.id);
  });
  await announce(job);
  return {
    job: view(job)
  };
};
exports.jobFile = async (gateway, jobId, lease) => tx(async client => {
  const j = await ownedJob(client, gateway, jobId, lease, {
    allowExpired: true
  });
  if (!['SEND', 'RESTORE'].includes(j.action) || !j.file_id) throw fail('This command has no server source file.', 'NO_FILE', 404);
  const file = await fileFor(client, j.file_id, {
    id: j.machine_id,
    company_id: j.company_id
  });
  await audit(client, {
    company_id: j.company_id,
    gateway_id: j.gateway_id,
    machine_id: j.machine_id,
    job_id: j.id,
    file_id: file.id,
    action: 'GATEWAY_FILE_DOWNLOAD',
    details: {
      sha256: file.sha256
    }
  });
  return {
    job: j,
    file
  };
});
function listing(value) {
  if (!Array.isArray(value) || value.length > 2000) throw fail('Return at most 2000 controller entries.', 'BAD_LIST');
  return value.map(f => {
    const name = String(f?.name || '');
    if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw fail('Controller returned an invalid directory entry.', 'BAD_LIST');
    const size = f.size == null ? null : Number(f.size);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw fail('Invalid controller file size.', 'BAD_LIST');
    const modified = f.modified ? new Date(f.modified) : null;
    if (modified && Number.isNaN(modified.getTime())) throw fail('Invalid controller file timestamp.', 'BAD_LIST');
    return {
      name,
      is_directory: f.is_directory === true,
      size,
      modified: modified?.toISOString() || null
    };
  });
}
exports.result = async (gateway, jobId, body = {}) => {
  const status = String(body.status || '').toUpperCase();
  if (!['DONE', 'FAILED'].includes(status)) throw fail('Report DONE or FAILED.', 'BAD_STATUS');
  const message = String(body.message || '').trim().slice(0, 1000),
    errorCode = status === 'FAILED' ? String(body.error_code || 'GATEWAY_ERROR') : null;
  if (status === 'FAILED' && (!message || !/^[A-Z][A-Z0-9_]{0,59}$/.test(errorCode))) throw fail('Explain the failure with an uppercase error code.', 'BAD_ERROR');
  let changed = false;
  const finished = await tx(async client => {
    const j = await ownedJob(client, gateway, jobId, body.lease_token, {
      allowTerminal: true,
      allowExpired: true
    });
    if (['DONE', 'FAILED'].includes(j.status)) {
      if (j.status !== status || status === 'FAILED' && (j.message !== message || j.error_code !== errorCode)) throw fail('A different command result is already recorded.', 'RESULT_CONFLICT', 409);
      if (status === 'DONE' && ['SEND', 'RESTORE'].includes(j.action) &&
        (body.sha256 !== j.file_sha256 || body.verified !== true || body.safety_checked !== true || typeof body.replaced !== 'boolean')) {
        throw fail('A repeated write result must retain the verified controller proof.', 'RESULT_CONFLICT', 409);
      }
      if (status === 'DONE' && ['SEND', 'RESTORE'].includes(j.action) && typeof j.result_json?.replaced === 'boolean' && body.replaced !== j.result_json.replaced) throw fail('The controller replacement result is already recorded.', 'RESULT_CONFLICT', 409);
      return j;
    }
    const writing = ['SEND', 'RESTORE'].includes(j.action),
      expired = new Date(j.expires_at).getTime() <= Date.now();
    if (writing && status === 'DONE' && (body.verified !== true || body.safety_checked !== true || body.sha256 !== j.file_sha256 || typeof body.replaced !== 'boolean')) throw fail('Confirm controller safety and exact SHA-256 read-back before success.', 'WRITE_NOT_VERIFIED', 409);
    if (writing && status === 'DONE' && body.replaced && (!j.overwrite || !j.backup_file_id)) throw fail('Save the actual replaced controller file before authorized overwrite.', 'BACKUP_REQUIRED', 409);
    if (status === 'DONE' && ['BACKUP', 'FETCH'].includes(j.action)) throw fail('Upload and verify the actual controller file to finish this command.', 'CAPTURE_REQUIRED', 409);
    if (writing && ((expired || j.error_code === 'WRITE_STATE_UNKNOWN') && (body.reconciled !== true || body.verified !== true) || status === 'FAILED' && body.write_started !== false && (body.reconciled !== true || body.verified !== true))) {
      await client.query("UPDATE program_jobs SET stage='NEEDS_RECONCILIATION',error_code='WRITE_STATE_UNKNOWN',message='Controller write outcome is unknown. The gateway must verify controller contents before any retry.' WHERE id=$1", [j.id]);
      await audit(client, {
        company_id: j.company_id,
        gateway_id: j.gateway_id,
        machine_id: j.machine_id,
        job_id: j.id,
        action: 'WRITE_RECONCILIATION_REQUIRED'
      });
      changed = true;
      return getJob(client, j.id);
    }
    let resultJson = {
      verified: body.verified === true,
      reconciled: body.reconciled === true,
      ...(writing ? {
        safety_checked: body.safety_checked === true,
        sha256: status === 'DONE' ? body.sha256 : null,
        replaced: status === 'DONE' ? body.replaced : null,
        write_started: body.write_started === false ? false : null
      } : {})
    };
    if (j.action === 'LIST' && status === 'DONE') {
      const files = listing(body.listing);
      const path = cleanPath(body.path);
      if (path !== (j.command_parameters?.relative_path || '')) throw fail('Directory result does not match the requested path.', 'RESULT_CONFLICT', 409);
      resultJson = {
        path,
        files,
        truncated: body.truncated === true,
        current_program: body.current_program ? String(body.current_program).slice(0, 255) : null,
        capabilities: body.capabilities ? caps(body.capabilities) : undefined,
        limitations: Array.isArray(body.limitations) ? body.limitations.slice(0, 20).map(x => String(x).slice(0, 200)) : []
      };
    }
    await client.query('UPDATE program_jobs SET status=$2::text,stage=$2::varchar(40),message=$3,error_code=$4,result_json=$5,finished_at=NOW() WHERE id=$1', [j.id, status, message || null, errorCode, resultJson]);
    await audit(client, {
      company_id: j.company_id,
      gateway_id: j.gateway_id,
      machine_id: j.machine_id,
      job_id: j.id,
      action: 'COMMAND_' + status,
      details: {
        action: j.action,
        error_code: errorCode,
        verified: body.verified === true
      }
    });
    changed = true;
    return getJob(client, j.id);
  });
  if (changed) await announce(finished);
  return {
    job: view(finished)
  };
};
exports.capture = async (gateway, jobId, body = {}, upload) => {
  if (!upload?.path) throw fail('Upload the actual controller file.', 'NO_FILE');
  const type = String(body.type || ''),
    name = String(body.program_name || '');
  if (!['CURRENT', 'REPLACEMENT', 'FETCHED'].includes(type) || storage.safeProgramName(name) !== name || !/^[a-f0-9]{64}$/.test(String(body.sha256 || ''))) throw fail('Supply capture type, actual program filename and SHA-256.', 'BAD_CAPTURE');
  if (type === 'CURRENT' && !(body.current_program_verified === true || body.current_program_verified === 'true')) throw fail('Controller-supported current program identification is required.', 'CURRENT_PROGRAM_UNKNOWN', 409);
  if (type === 'CURRENT' && body.controller_reported_name !== name) throw fail('Captured filename must equal the controller-reported running program.', 'CURRENT_PROGRAM_UNKNOWN', 409);
  let saved,
    changed = false,
    replay = false;
  try {
    const output = await tx(async client => {
      const j = await ownedJob(client, gateway, jobId, body.lease_token, {
        allowTerminal: true,
        allowExpired: true
      });
      const expected = type === 'CURRENT' ? 'BACKUP' : type === 'FETCHED' ? 'FETCH' : null;
      if (expected && j.action !== expected) throw fail('Capture does not match this command.', 'WRONG_ACTION', 409);
      if (type === 'REPLACEMENT' && (!['SEND', 'RESTORE'].includes(j.action) || !j.overwrite || j.program_name !== name)) throw fail('Replacement capture must match an authorized overwrite.', 'WRONG_ACTION', 409);
      if (type === 'FETCHED' && j.program_name !== name) throw fail('Controller returned a different requested filename.', 'RESULT_CONFLICT', 409);
      const previous = type === 'REPLACEMENT' ? j.backup_file_id : j.file_id;
      if (previous) {
        saved = await storage.saveStream({
          machine: {
            id: j.machine_id,
            company_id: j.company_id
          },
          kind: type === 'FETCHED' ? 'FETCHED' : 'BACKUP',
          programName: name,
          filename: upload.path,
          expectedSha256: body.sha256
        });
        replay = true;
        const prior = await fileFor(client, previous, {
          id: j.machine_id,
          company_id: j.company_id
        });
        if (prior.sha256 !== body.sha256 || prior.program_name !== name) throw fail('A different capture is already recorded.', 'RESULT_CONFLICT', 409);
        return {
          file: prior,
          job: view(j)
        };
      }
      if (j.status !== 'DELIVERED') throw fail('This command no longer accepts a new capture.', 'JOB_NOT_OPEN', 409);
      saved = await storage.saveStream({
        machine: {
          id: j.machine_id,
          company_id: j.company_id
        },
        kind: type === 'FETCHED' ? 'FETCHED' : 'BACKUP',
        programName: name,
        filename: upload.path,
        expectedSha256: body.sha256
      });
      const file = await insertFile(client, {
        id: j.machine_id,
        company_id: j.company_id
      }, saved, {
        gatewayId: j.gateway_id,
        jobId: j.id,
        kind: type === 'FETCHED' ? 'FETCHED' : 'BACKUP',
        provenance: {
          source: type === 'CURRENT' ? 'CURRENT_RUNNING' : type,
          captured_at: new Date().toISOString(),
          controller_reported_name: type === 'CURRENT' ? name : null,
          configuration_version: j.configuration_version,
          sha256: saved.sha256
        }
      });
      if (type === 'REPLACEMENT') await client.query('UPDATE program_jobs SET backup_file_id=$2 WHERE id=$1', [j.id, file.id]);else await client.query("UPDATE program_jobs SET file_id=$2,program_name=$3,status='DONE',stage='DONE',finished_at=NOW(),result_json=$4 WHERE id=$1", [j.id, file.id, name, {
        verified: true,
        source: type === 'CURRENT' ? 'CURRENT_RUNNING' : 'CONTROLLER_FILE',
        file_id: file.id
      }]);
      await audit(client, {
        company_id: j.company_id,
        gateway_id: j.gateway_id,
        machine_id: j.machine_id,
        job_id: j.id,
        file_id: file.id,
        action: 'CONTROLLER_CAPTURED',
        details: {
          type,
          program_name: name,
          size_bytes: file.size_bytes,
          sha256: file.sha256
        }
      });
      changed = true;
      const job = await getJob(client, j.id);
      return {
        file,
        job: view(job),
        _job: job
      };
    });
    if (replay && saved) await storage.remove(saved.folder, saved.storedName);
    if (changed && output._job) await announce(output._job);
    delete output._job;
    return output;
  } catch (error) {
    if (saved && (!error.commitUncertain || replay)) await storage.remove(saved.folder, saved.storedName).catch(() => {});
    throw error;
  }
};
exports.deleteFile = async req => {
  company(req);
  const file = await exports.getFile({
    ...req,
    skipAudit: true
  });
  const changed = await tx(async client => {
    await machineFor(client, file.machine_id, req.user, true);
    const busy = await client.query('SELECT id FROM program_jobs WHERE(file_id=$1 OR backup_file_id=$1) AND status=ANY($2) LIMIT 1', [file.id, OPEN]);
    if (busy.rows.length) throw fail('This file belongs to an open command.', 'FILE_IN_USE', 409);
    await client.query('UPDATE program_files SET deleted_at=NOW(),deleted_by=$2 WHERE id=$1 AND company_id=$3', [file.id, req.user.id, req.user.company_id]);
    await audit(client, {
      company_id: req.user.company_id,
      machine_id: file.machine_id,
      file_id: file.id,
      actor_id: req.user.id,
      action: 'PROGRAM_DELETED',
      details: {
        sha256: file.sha256
      }
    });
    return true;
  });
  if (changed) await storage.remove(file.folder, file.stored_name);
  return {
    deleted: true
  };
};
exports._internal = {
  view,
  descriptor,
  cleanPath,
  caps
};
