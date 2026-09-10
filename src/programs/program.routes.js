const express = require('express');
const router = express.Router();
const multer = require('multer');

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./program.controller');
const authController = require('./authorization.controller');

// G-code / NC program files are plain text; accept by extension
// since controllers and CAM software produce inconsistent MIME types.
const ALLOWED_EXTENSIONS = ['.nc', '.prg', '.cnc', '.txt', '.tap', '.eia', '.min', '.gcode'];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB — NC programs are small text files
});

/* Every route below used to carry `auth` alone: any authenticated user
   could push G-code to any machine in their company. The agreement asks
   for "role-based access control for program upload, download, and
   deletion operations", so each action now names its own permission.
   Migration 013 grants these to the system roles — permissions live in
   the JWT, so users need a fresh login (or up to 15 minutes) after
   deploy before the grants take effect. */

// Upload a new program
router.post('/', auth, permit('page:programs:upload'), upload.single('file'), controller.createProgram);

// List programs
router.get('/', auth, permit('page:programs:view'), controller.getPrograms);

// Transfer history (must come before /:id routes)
router.get('/transfers', auth, permit('page:programs:view'), controller.getTransfers);

// Programs saved off a machine before an overwrite replaced them
router.get('/backups', auth, permit('page:programs:view'), controller.getBackups);

// Test FTP connection (body: machine_id and/or ip_address, ftp_port, ftp_user, ftp_pass)
router.post('/test-connection', auth, permit('page:programs:transfer'), controller.testConnection);

/* ── supervisor authorisation ──
   Request a one-time code before sending anything to a controller. */
router.post('/authorization/request', auth, permit('page:programs:transfer'), authController.requestAuthorization);
router.get('/machine/:machineId/supervisors', auth, permit('page:programs:view'), authController.getSupervisors);

/* ── controller-side file browser ──
   Literal segments before the /:id routes so "machine" is never read
   as a program id. */
router.get('/machine/:machineId/files',  auth, permit('page:programs:view'),  controller.listMachinePrograms);
router.get('/machine/:machineId/status', auth, permit('page:programs:view'),  controller.getMachineStatus);
router.post('/machine/:machineId/fetch', auth, permit('page:programs:fetch'), controller.fetchFromMachine);

// Send several programs to several machines in one action
router.post('/transfer-batch', auth, permit('page:programs:transfer'), controller.transferBatch);

// Download original program file
router.get('/:id/download', auth, permit('page:programs:view'), controller.downloadProgram);

// Send program to machine over FTP
router.post('/:id/transfer/:machineId', auth, permit('page:programs:transfer'), controller.transferProgram);

// Delete program
router.delete('/:id', auth, permit('page:programs:delete'), controller.deleteProgram);

module.exports = router;
