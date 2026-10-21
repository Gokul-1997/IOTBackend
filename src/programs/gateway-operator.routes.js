const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const role = require('../middleware/role.middleware');
const service = require('./gateway.service');
const uploads = require('./gateway-upload');
const {
  handle,
  download
} = require('./gateway-http');
const heavy = require('../middleware/heavy.middleware');
const success = (res, data, status = 200) => res.status(status).json({
  status: 'success',
  data
});
router.use(auth, access('page:programs:view'));
const admin = [role(['COMPANY_ADMIN', 'ADMIN']), access('page:machines:edit')];
router.get('/machines', handle(async (req, res) => success(res, await service.listMachines(req))));
router.get('/machines/:machineId/status', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  success(res, await service.status(req));
}));
router.get('/gateways', ...admin, handle(async (req, res) => success(res, await service.listGateways(req))));
router.post('/gateways', ...admin, handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  success(res, await service.createGateway(req), 201);
}));
router.post('/gateways/:gatewayId/token', ...admin, handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  success(res, await service.rotateGateway(req), 201);
}));
router.delete('/gateways/:gatewayId/token', ...admin, handle(async (req, res) => success(res, await service.revokeGateway(req))));
router.put('/machines/:machineId/gateway', ...admin, handle(async (req, res) => success(res, await service.saveAssignment(req))));
router.post('/machines/:machineId/uploads', access('page:programs:upload'), heavy, handle(async (req, res) => {
  await uploads.parse(req, res);
  success(res, await service.upload(req), 201);
}));
for (const [action, path, permission] of [['SEND', 'send', 'transfer'], ['RESTORE', 'restore', 'transfer'], ['BACKUP', 'backup', 'fetch'], ['LIST', 'browse', 'view'], ['FETCH', 'fetch', 'fetch']]) {
  router.post(`/machines/:machineId/${path}`, access(`page:programs:${permission}`), handle(async (req, res) => success(res, await service.createCommand(req, action), 201)));
}
router.get('/files', handle(async (req, res) => res.json({
  status: 'success',
  ...(await service.listFiles(req))
})));
router.get('/files/:id/download', handle(async (req, res) => download(req, res, await service.getFile(req))));
router.delete('/files/:id', access('page:programs:delete'), handle(async (req, res) => success(res, await service.deleteFile(req))));
router.get('/jobs', handle(async (req, res) => res.json({
  status: 'success',
  ...(await service.listJobs(req))
})));
router.post('/jobs/:id/cancel', handle(async (req, res) => success(res, await service.cancel(req))));
router.post('/jobs/:id/retry', handle(async (req, res) => success(res, await service.retry(req), 201)));
module.exports = router;
