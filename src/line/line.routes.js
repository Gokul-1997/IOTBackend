const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./line.controller');

router.post('/', auth, permit('line.create'), controller.createLine);
router.get('/', auth, permit('line.view'), controller.getLines);
router.put('/:id', auth, permit('line.update'), controller.updateLine);
router.delete('/:id', auth, permit('line.delete'), controller.deleteLine);

module.exports = router;