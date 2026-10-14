const express = require('express');
const router = express.Router();
const controller = require('./plant.controller');
const validate    = require('../middleware/validate.middleware');
const access = require('../middleware/access.middleware');
const auth        = require('../middleware/auth.middleware');
const checkQuota  = require('../middleware/quota.middleware');

router.get('/',    auth, access('page:plants:view'), controller.getPlants);
router.get('/:id', auth, access('page:plants:view'), controller.getPlantById);

// Enforce plan quota: company cannot exceed max_plants before creating a new one
router.post('/', auth, access('page:plants:create'), checkQuota('plants'), validate({
  plant_code: { required: true, maxLength: 20,  label: 'Plant code' },
  plant_name: { required: true, maxLength: 100, label: 'Plant name' }
}), controller.createPlant);

router.put('/:id',         auth, access('page:plants:edit'), controller.updatePlant);
router.patch('/:id/status', auth, access('page:plants:edit'), controller.togglePlantStatus);
router.delete('/:id',      auth, access('page:plants:delete'), controller.deletePlant);

module.exports = router;
