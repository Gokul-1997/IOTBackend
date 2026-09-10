const express = require('express');
const router = express.Router();
const controller = require('./plant.controller');
const validate    = require('../middleware/validate.middleware');
const auth        = require('../middleware/auth.middleware');
const checkQuota  = require('../middleware/quota.middleware');

router.get('/',    auth, controller.getPlants);
router.get('/:id', auth, controller.getPlantById);

// Enforce plan quota: company cannot exceed max_plants before creating a new one
router.post('/', auth, checkQuota('plants'), validate({
  plant_code: { required: true, maxLength: 20,  label: 'Plant code' },
  plant_name: { required: true, maxLength: 100, label: 'Plant name' }
}), controller.createPlant);

router.put('/:id',         auth, controller.updatePlant);
router.patch('/:id/status', auth, controller.togglePlantStatus);
router.delete('/:id',      auth, controller.deletePlant);

module.exports = router;
