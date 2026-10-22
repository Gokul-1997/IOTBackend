/**
 * /api/programs — Program Transfer for people. The company's gateway uses
 * /api/device/v1 (device.routes.js) with the company's token instead; S&T
 * makes that token (companies/company.routes.js → /:id/program-gateway), so
 * nothing here makes or shows one.
 *
 * Permissions (page:programs:*): view — machines, files, downloads;
 * upload + transfer — upload a program (it joins the machine's line);
 * fetch — ask the machine for a backup; delete — remove a file.
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

/* The machines, and beside them the company's gateway: online or not (one for all machines). */
router.get('/machines', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { machines, gateway } = await service.listMachines(req);
  res.json({ status: 'success', data: machines, gateway });
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

module.exports = router;
