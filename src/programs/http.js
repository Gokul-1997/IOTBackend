/** One error shape and one download for both Program Transfer APIs (people and gateway). */
const multer = require('multer');
const { pipeline } = require('node:stream/promises');
const storage = require('./storage');
const uploads = require('./upload');

/* Errors carry a code a gateway or the page can act on; the message is a
   sentence to show. A staged upload is always removed afterwards. */
exports.handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);   // half a file sent: cut it, so the reader sees a broken download
    if (error instanceof multer.MulterError) {
      const tooBig = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        status: 'error', code: tooBig ? 'TOO_LARGE' : 'BAD_UPLOAD',
        message: tooBig ? `The file is larger than ${Math.round(storage.MAX_BYTES / 1048576)} MB.` : 'Send the file as multipart form data, field "file".'
      });
    }
    const status = error.status || (['23514', '23505'].includes(error.code) ? 409 : 500);
    if (status >= 500) console.error('[programs]', req.method, req.originalUrl, error.message);
    res.status(status).json({
      status: 'error',
      code: status >= 500 ? 'SERVER_ERROR' : error.code,
      message: status >= 500 ? 'The server could not finish this. Try again.' : error.message
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
      status: 404, code: 'FILE_GONE', message: 'The saved file is no longer on the server.'
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
