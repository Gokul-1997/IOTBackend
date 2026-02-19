const express = require('express');
const router = express.Router();
const multer = require('multer');
const { UploadFile } = require('../upload/upload.controller.js');
const auth = require('../middleware/auth.middleware');

const storage = multer.memoryStorage();

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ["image/jpeg", "image/png"];
        if (allowedMimeTypes.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Unsupported file type!"), false);
    },
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});
router.post('/', auth, upload.single('file'), UploadFile);

module.exports = router;
