/**
 * /api/programs — Program Transfer for people. The machines' devices use
 * /api/device/v1 (device.routes.js) with their own tokens instead.
 *
 * Permissions (page:programs:*): view — see machines, files, jobs;
 * upload — add a program to a machine's folder; transfer — send programs to
 * machines; fetch — ask a machine for a program on its controller;
 * delete — remove a file. A device token is a machine credential, so it
 * takes Machines → Edit, including the company's grant, like the machine's
 * MQTT key.
 */
const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const controller = require('./program.controller');
const heavy = require('../middleware/heavy.middleware');

router.get('/machines', auth, access('page:programs:view'), controller.listMachines);
router.put('/machines/:machineId/connection', auth, access('page:programs:view'), access('page:machines:edit'), controller.saveConnection);
router.get('/machines/:machineId/status', auth, access('page:programs:view'), controller.commandStatus);
router.post('/machines/:machineId/transfer', auth, access('page:programs:view'), access('page:programs:upload'), access('page:programs:transfer'), heavy, controller.transfer);
router.post('/machines/:machineId/backup', auth, access('page:programs:view'), access('page:programs:fetch'), controller.backup);
router.get('/machines/:machineId/current-program', auth, access('page:programs:view'), controller.getCurrentProgram);
router.post('/machines/:machineId/current-program', auth, access('page:programs:upload'), access('page:programs:transfer'), heavy, controller.publishCurrentProgram);
router.get('/machines/:machineId/controller-files', auth, access('page:programs:view'), controller.controllerFiles);
router.post('/machines/:machineId/device-token', auth, access('page:machines:edit'), controller.createDeviceToken);
router.delete('/machines/:machineId/device-token', auth, access('page:machines:edit'), controller.revokeDeviceToken);

router.get('/files', auth, access('page:programs:view'), controller.listFiles);
router.post('/files', auth, access('page:programs:upload'), heavy, controller.uploadFile);
router.get('/files/:id/download', auth, access('page:programs:view'), controller.downloadFile);
router.delete('/files/:id', auth, access('page:programs:delete'), controller.deleteFile);

// SEND needs page:programs:transfer, FETCH page:programs:fetch — checked in the service
router.post('/jobs', auth, access('page:programs:view'), controller.createJobs);
router.get('/jobs', auth, access('page:programs:view'), controller.listJobs);
router.post('/jobs/:id/cancel', auth, access('page:programs:view'), controller.cancelJob);

module.exports = router;
