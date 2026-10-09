/**
 * /api/device/v1 — the Program Transfer API the machine's device calls.
 * Documented for the device team in docs/PROGRAM_TRANSFER_DEVICE_API.md;
 * change the two together.
 *
 *   GET  /ping                     check the token; the device's heartbeat
 *   GET  /program                  download the current program repeatedly
 *   GET  /program/info             current program metadata, or file: null
 *   POST /backup                   save a machine backup, without changing the current program
 *   GET  /jobs/next                the next job for this machine (204: none)
 *   GET  /jobs/:id/file            the program of a SEND job
 *   POST /files                    a program read off the controller (type BACKUP | FETCHED)
 *   POST /jobs/:id/result          DONE | FAILED
 *   PUT  /controller-files         the list of programs on the controller
 */
const express = require('express');
const multer = require('multer');
const deviceAuth = require('../middleware/device.middleware');
const { deviceFailLimiter, deviceLimiter } = require('../middleware/rateLimit.middleware');
const storage = require('./storage');
const service = require('./device.service');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: storage.MAX_BYTES, files: 1, fields: 10 }
});

/* Errors carry a code a device can branch on; the message is for the log. */
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (res.headersSent) {            // the file was half sent: cut it, so the device sees a broken download
      console.error('[device api]', req.method, req.path, e);
      return res.destroy();
    }
    if (e instanceof multer.MulterError) {
      const tooBig = e.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        status: 'error', code: tooBig ? 'TOO_LARGE' : 'BAD_UPLOAD',
        message: tooBig ? `The file is larger than ${Math.round(storage.MAX_BYTES / 1048576)} MB.` : e.message
      });
    }
    const status = e.status || 500;
    if (status >= 500) console.error('[device api]', req.method, req.path, e);
    res.status(status).json({ status: 'error', code: e.code || 'SERVER_ERROR', message: status >= 500 ? 'Server error. Try again.' : e.message });
  }
};

router.use(deviceFailLimiter, deviceAuth, deviceLimiter);

router.get('/ping', handle(async (req, res) => res.json(await service.ping(req.device))));

router.get('/program/info', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await service.currentInfo(req.device));
}));

router.get('/program', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const file = await service.currentFile(req.device);
  const stream = storage.open(file.folder, file.stored_name);
  // Open before setting a byte length so a missing disk file can still
  // return a complete JSON error response.
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', err => reject(Object.assign(err, err.code === 'ENOENT'
      ? { status: 404, code: 'FILE_GONE', message: 'The current program file is unavailable. Upload it again.' } : {})));
  });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.program_name)}"`);
  res.setHeader('X-Program-Name', encodeURIComponent(file.program_name));
  res.setHeader('X-File-Id', String(file.id));
  res.setHeader('X-Sha256', file.sha256);
  res.once('close', () => stream.destroy());
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('end', resolve);
    stream.pipe(res);
  });
}));

router.get('/jobs/next', handle(async (req, res) => {
  const job = await service.nextJob(req.device);
  if (!job) return res.status(204).end();
  res.json({ job });
}));

router.get('/jobs/:id/file', handle(async (req, res) => {
  const { job, file } = await service.jobFile(req.device, req.params.id);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.program_name)}"`);
  res.setHeader('X-Program-Name', encodeURIComponent(job.program_name));
  res.setHeader('X-Sha256', file.sha256);
  res.setHeader('Cache-Control', 'no-store');
  await new Promise((resolve, reject) => {
    const stream = storage.open(file.folder, file.stored_name);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}));

/* multer inside the handler, so a file over the limit answers with the
   same JSON shape as every other error */
const parseUpload = (req, res) => new Promise((resolve, reject) =>
  upload.single('file')(req, res, err => (err ? reject(err) : resolve())));

router.post('/backup', handle(async (req, res) => {
  await parseUpload(req, res);
  const body = req.body || {};
  const file = await service.uploadFile(req.device, {
    file: req.file, type: 'BACKUP', program_name: body.program_name,
    sha256: body.sha256, note: body.note
  });
  res.status(201).json({ file });
}));

router.post('/files', handle(async (req, res) => {
  await parseUpload(req, res);
  const body = req.body || {};
  const saved = await service.uploadFile(req.device, {
    file: req.file, type: body.type, job_id: body.job_id, program_name: body.program_name,
    sha256: body.sha256, note: body.note
  });
  res.status(201).json({ file: saved });
}));

router.post('/jobs/:id/result', handle(async (req, res) => {
  const job = await service.reportResult(req.device, req.params.id, req.body || {});
  res.json({ job: { id: Number(job.id), status: job.status } });
}));

router.put('/controller-files', handle(async (req, res) => {
  res.json(await service.reportControllerFiles(req.device, (req.body || {}).files));
}));

module.exports = router;
