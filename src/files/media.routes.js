const express = require('express');
const auth = require('../middleware/auth.middleware');
const { idOrNull } = require('../lib/plant-scope');
const media = require('./media.service');
const local = require('./local-storage');
const router = express.Router();

router.get('/companies/:companyId/images/machines/:filename', auth, async (req, res, next) => {
  let opened;
  try {
    const company = idOrNull(req.params.companyId, 'Company');
    const asset = await media.authorizeRead(req.user, company, req.params.filename);
    try { opened = await local.open(media.directory(company), asset.filename); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw { status: 404, message: 'Image file is missing. Upload it again or restore its file backup.', code: 'IMAGE_FILE_MISSING' };
      throw error;
    }
    if (opened.size !== Number(asset.size_bytes)) throw { status: 503, message: 'Image file could not be verified. Restore its file backup.', code: 'IMAGE_FILE_INVALID' };
    const etag = `"${asset.sha256}"`;
    res.set({ 'Content-Type': asset.mime_type, 'Content-Length': String(opened.size),
      'Cache-Control': 'private, no-cache', 'ETag': etag, 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${asset.filename}"` });
    if (req.headers['if-none-match'] === etag) {
      opened.stream.destroy();
      return res.status(304).end();
    }
    opened.stream.once('error', next);
    res.once('close', () => opened.stream.destroy());
    opened.stream.pipe(res);
  } catch (error) { opened?.stream.destroy(); next(error); }
});

module.exports = router;
