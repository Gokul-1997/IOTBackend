/**
 * /api/programs — Program Transfer for people. The machine's gateway uses
 * /api/device/v1 (device.routes.js) with the machine's own token instead.
 *
 * Permissions (page:programs:*): view — machines, files, downloads;
 * upload + transfer — upload a program (it goes to the machine);
 * fetch — ask the machine for a backup; delete — remove a file.
 * A gateway token is a machine credential, so it takes Machines → Edit,
 * like the machine's MQTT key.
 */
const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const heavy = require('../middleware/heavy.middleware');
const service = require('./program.service');
const uploads = require('./upload');
const { handle, download } = require('./http');

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

router.use(auth, access('page:programs:view'));

router.get('/machines', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.listMachines(req));
}));

router.get('/files', handle(async (req, res) => {
  const { data, pagination } = await service.listFiles(req);
  res.json({ status: 'success', data, pagination });
}));

router.post('/files', access('page:programs:upload'), access('page:programs:transfer'), heavy, handle(async (req, res) => {
  await uploads.parse(req, res);
  ok(res, await service.upload(req), 201);
}));

router.get('/files/:id/download', handle(async (req, res) => download(req, res, await service.getFile(req))));

router.delete('/files/:id', access('page:programs:delete'), handle(async (req, res) => {
  await service.deleteFile(req);
  ok(res, { deleted: true });
}));

router.post('/machines/:machineId/backup', access('page:programs:fetch'), handle(async (req, res) => {
  const request = await service.requestBackup(req);
  ok(res, request, request.created ? 201 : 200);
}));

router.post('/machines/:machineId/device-token', access('page:machines:edit'), handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.createDeviceToken(req), 201);
}));

router.delete('/machines/:machineId/device-token', access('page:machines:edit'), handle(async (req, res) => {
  await service.revokeDeviceToken(req);
  ok(res, { revoked: true });
}));

module.exports = router;
