const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const heavy = require('../middleware/heavy.middleware');
const media = require('../files/media.service');
const { UploadFile } = require('./upload.controller');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: media.MAX_BYTES, files: 1, fields: 1, fieldSize: 20, parts: 2 },
  fileFilter: (_req, file, callback) => {
    if (!media.ALLOWED_MIME.has(file.mimetype)) return callback({ status: 400, message: 'Choose a JPEG, PNG or WebP image', code: 'IMAGE_TYPE_NOT_SUPPORTED' });
    callback(null, true);
  }
}).single('file');

// Authentication, company ownership, grants and bounded admission run before
// multer allocates a file buffer. The body cannot choose another tenant.
router.post('/', auth, (req, _res, next) => {
  try { media.requireCompany(req.user); next(); } catch (error) { next(error); }
}, access.any('page:machines:create', 'page:machines:edit'), heavy,
  (req, res, next) => upload(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) return next({
      status: 400,
      code: error.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE_UPLOAD',
      message: error.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : 'Upload one image in the file field and one plant_id field'
    });
    next(error);
  }), UploadFile);

module.exports = router;
