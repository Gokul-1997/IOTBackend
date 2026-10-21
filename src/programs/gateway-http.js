const multer = require('multer');
const {
  pipeline
} = require('node:stream/promises');
const storage = require('./storage');
const uploads = require('./gateway-upload');
exports.handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    const status = error instanceof multer.MulterError ? error.code === 'LIMIT_FILE_SIZE' ? 413 : 400 : error.status || (['23514', '23505'].includes(error.code) ? 409 : 500);
    if (status >= 500) console.error('[gateway transfer]', error.message);
    res.status(status).json({
      status: 'error',
      code: error.code || 'SERVER_ERROR',
      message: status >= 500 ? 'The server could not finish this operation. Try again.' : error.message
    });
  } finally {
    await uploads.cleanup(req).catch(error => console.error('[program staging cleanup]', error.message));
  }
};
exports.download = async (req, res, file) => {
  const stream = storage.open(file.folder, file.stored_name);
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', error => reject(Object.assign(error, error.code === 'ENOENT' ? {
      status: 404,
      code: 'FILE_GONE',
      message: 'The saved file is unavailable.'
    } : {})));
  });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.program_name)}"`);
  res.setHeader('X-Sha256', file.sha256);
  res.setHeader('X-Program-Name', encodeURIComponent(file.program_name));
  res.setHeader('Cache-Control', 'no-store');
  res.once('close', () => stream.destroy());
  await pipeline(stream, res);
};
