/**
 * /api/device/v1 — the four calls a company's gateway makes. Documented for
 * the gateway team in docs/PROGRAM_TRANSFER_API.md and the Postman collection
 * docs/postman/MEXA_Program_Transfer.postman_collection.json; change all
 * three together.
 *
 *   GET  /status    { company, machines: [...], poll_seconds } — every machine, one call:
 *                   machine_id, name, IP, controller_name, api_key, program_path,
 *                   machine_status, on_hold (in alarm, emergency stop or disconnected:
 *                   nothing is offered for it), …
 *   GET  /program   ?machine_id=ID: that machine's next program (409 MACHINE_ON_HOLD while on hold)
 *   POST /backup    multipart "machine_id" + "file": a backup from a machine
 *   POST /report    JSON: the program is on the machine / was refused,
 *                   or a backup could not be read
 *
 * A machine is named by its machine_id (23 Oct 2026); gateways built before
 * may still send its name ("machine") or IP ("machine_ip").
 *
 * Every call sends "Authorization: Bearer mxg_…", the company's one token
 * (S&T makes it), so a call can only ever reach that company's machines.
 */
const express = require('express');
const deviceAuth = require('../middleware/device.middleware');
const { deviceFailLimiter, deviceLimiter } = require('../middleware/rateLimit.middleware');
const service = require('./program.service');
const uploads = require('./upload');
const { handle, download } = require('./http');

const router = express.Router();

router.use(deviceFailLimiter, deviceAuth, deviceLimiter);

router.get('/status', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await service.gatewayStatus(req.gateway));
}));

router.get('/program', handle(async (req, res) => {
  const { machine, program } = await service.gatewayProgram(req.gateway, req.query);
  res.setHeader('X-File-Id', String(program.id));
  res.setHeader('X-Machine-Id', String(machine.id));
  res.setHeader('X-Machine', encodeURIComponent(machine.machine_serial_no));
  await download(req, res, program);
}));

router.post('/backup', handle(async (req, res) => {
  await uploads.parse(req, res);
  res.status(201).json(await service.gatewayBackup(req.gateway, req.file, req.body || {}));
}));

router.post('/report', handle(async (req, res) => {
  res.json(await service.gatewayReport(req.gateway, req.body || {}));
}));

module.exports = router;
