const multer = require('multer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const staging = multer.diskStorage({
  destination(req, _file, callback) {
    fs.mkdtemp(path.join(os.tmpdir(), 'mexa-cnc-'), (error, folder) => {
      if (!error) req.programStaging = folder;
      callback(error, folder);
    });
  },
  filename(_req, _file, callback) {
    callback(null, crypto.randomUUID());
  }
});
const upload = multer({
  storage: staging,
  limits: {
    fileSize: storage.MAX_BYTES,
    files: 1,
    fields: 12,
    fieldSize: 2048
  }
}).single('file');
exports.parse = (req, res) => new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
exports.cleanup = req => req.programStaging ? fs.promises.rm(req.programStaging, {
  recursive: true,
  force: true
}) : Promise.resolve();
