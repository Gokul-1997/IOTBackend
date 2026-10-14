const express = require('express');
const router = express.Router();

const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');
const controller = require('./line.controller');

router.post('/', auth, access('page:lines:create'), validate({
  name: { required: true, maxLength: 100, label: 'Line name' },
  is_active: { type: 'boolean' }
}), controller.createLine);
router.get('/', auth, permit('line.view'), controller.getLines);
router.put('/:id', auth, access('page:lines:edit'), validate({
  name: { maxLength: 100, label: 'Line name' },
  is_active: { type: 'boolean' }
}), controller.updateLine);
router.delete('/:id', auth, access('page:lines:delete'), controller.deleteLine);

module.exports = router;