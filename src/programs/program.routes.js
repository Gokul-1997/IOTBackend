/**
 * /api/programs — Program Transfer for people. The machines' devices use
 * /api/device/v1 (device.routes.js) with their own tokens instead.
 *
 * Permissions (page:programs:*): view — see machines, files, jobs;
 * upload — add a program to a machine's folder; transfer — send programs to
 * machines; fetch — ask a machine for a program on its controller;
 * delete — remove a file. A device token is a machine credential, so it
 * takes what changing a machine takes (machine.update), like the machine's
 * MQTT key.
 */
const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./program.controller');

router.get('/machines', auth, permit('page:programs:view'), controller.listMachines);
router.get('/machines/:machineId/controller-files', auth, permit('page:programs:view'), controller.controllerFiles);
router.post('/machines/:machineId/device-token', auth, permit('machine.update'), controller.createDeviceToken);
router.delete('/machines/:machineId/device-token', auth, permit('machine.update'), controller.revokeDeviceToken);

router.get('/files', auth, permit('page:programs:view'), controller.listFiles);
router.post('/files', auth, permit('page:programs:upload'), controller.uploadFile);
router.get('/files/:id/download', auth, permit('page:programs:view'), controller.downloadFile);
router.delete('/files/:id', auth, permit('page:programs:delete'), controller.deleteFile);

// SEND needs page:programs:transfer, FETCH page:programs:fetch — checked in the service
router.post('/jobs', auth, permit('page:programs:view'), controller.createJobs);
router.get('/jobs', auth, permit('page:programs:view'), controller.listJobs);
router.post('/jobs/:id/cancel', auth, permit('page:programs:view'), controller.cancelJob);

module.exports = router;
