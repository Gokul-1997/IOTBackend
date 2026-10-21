/**
 * /api/device/v1 — the four calls a machine's gateway makes. Documented for
 * the gateway team in docs/PROGRAM_TRANSFER_API.md and the Postman collection
 * docs/postman/MEXA_Program_Transfer.postman_collection.json; change all
 * three together.
 *
 *   GET  /status    { program, backup_request, poll_seconds } — poll it
 *   GET  /program   the machine's program (its newest upload)
 *   POST /backup    multipart "file": a backup from the machine
 *   POST /report    JSON: the program is on the machine / was refused,
 *                   or a backup could not be read
 *
 * Every call sends "Authorization: Bearer mxd_…", the machine's token, so a
 * call never names a machine and cannot reach another one.
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
  res.json(await service.deviceStatus(req.device));
}));

router.get('/program', handle(async (req, res) => {
  const file = await service.deviceProgram(req.device);
  res.setHeader('X-File-Id', String(file.id));
  await download(req, res, file);
}));

router.post('/backup', handle(async (req, res) => {
  await uploads.parse(req, res);
  res.status(201).json(await service.deviceBackup(req.device, req.file, req.body || {}));
}));

router.post('/report', handle(async (req, res) => {
  res.json(await service.deviceReport(req.device, req.body || {}));
}));

module.exports = router;
