const multer = require('multer');
const service = require('./program.service');
const storage = require('./storage');

/* One error shape for the screen: a code it can act on (FILE_EXISTS asks
   "overwrite?"), the names involved, and a sentence to show. */
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (res.headersSent) { console.error('[programs]', e); return res.destroy(); }
    if (e instanceof multer.MulterError) {
      const tooBig = e.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        status: 'error', code: tooBig ? 'TOO_LARGE' : 'BAD_UPLOAD',
        message: tooBig ? `The file is larger than ${Math.round(storage.MAX_BYTES / 1048576)} MB.` : e.message
      });
    }
    const status = e.status || 500;
    if (status >= 500) console.error('[programs]', req.method, req.originalUrl, e);
    res.status(status).json({
      status: 'error', code: e.code, names: e.names,
      message: status >= 500 ? 'Something went wrong on the server. Try again.' : e.message
    });
  }
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: storage.MAX_BYTES, files: 1, fields: 10 } });
const parseUpload = (req, res) => new Promise((resolve, reject) =>
  upload.single('file')(req, res, err => (err ? reject(err) : resolve())));

exports.listMachines = handle(async (req, res) => res.json({ status: 'success', data: await service.listMachines(req) }));

exports.controllerFiles = handle(async (req, res) => res.json({ status: 'success', data: await service.controllerFiles(req) }));

exports.getCurrentProgram = handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: await service.getCurrentProgram(req) });
});

exports.publishCurrentProgram = handle(async (req, res) => {
  await parseUpload(req, res);
  const data = await service.publishCurrentProgram(req);
  res.status(201).json({ status: 'success', data, message: 'Program ready for the machine' });
});

exports.listFiles = handle(async (req, res) => {
  const r = await service.listFiles(req);
  res.json({ status: 'success', data: r.data, total: r.total, page: r.page, limit: r.limit });
});

exports.uploadFile = handle(async (req, res) => {
  await parseUpload(req, res);
  const data = await service.uploadFile(req);
  res.status(201).json({ status: 'success', data, message: data.job ? 'Uploaded and queued for the machine' : 'Uploaded' });
});

exports.downloadFile = handle(async (req, res) => {
  const file = await service.getFileForDownload(req);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.stored_name)}"`);
  await new Promise((resolve, reject) => {
    const stream = storage.open(file.folder, file.stored_name);
    stream.on('error', err => reject(Object.assign(err, err.code === 'ENOENT'
      ? { status: 404, code: 'FILE_GONE', message: 'The file is no longer in the ProgramTransfer folder.' } : {})));
    stream.on('end', resolve);
    stream.pipe(res);
  });
});

exports.deleteFile = handle(async (req, res) => {
  await service.deleteFile(req);
  res.json({ status: 'success', message: 'Program deleted' });
});

exports.createJobs = handle(async (req, res) => {
  const data = await service.createJobs(req);
  res.status(201).json({ status: 'success', data, message: `${data.jobs.length} job${data.jobs.length === 1 ? '' : 's'} queued` });
});

exports.listJobs = handle(async (req, res) => {
  const r = await service.listJobs(req);
  res.json({ status: 'success', data: r.data, total: r.total, page: r.page, limit: r.limit });
});

exports.cancelJob = handle(async (req, res) => res.json({ status: 'success', data: await service.cancelJob(req), message: 'Job cancelled' }));

exports.createDeviceToken = handle(async (req, res) => {
  const data = await service.createDeviceToken(req);
  res.setHeader('Cache-Control', 'no-store');      // the token must not sit in a cache
  res.status(201).json({ status: 'success', data });
});

exports.revokeDeviceToken = handle(async (req, res) => {
  await service.revokeDeviceToken(req);
  res.json({ status: 'success', message: 'Device token revoked' });
});
