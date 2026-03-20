const express = require('express');
const router = express.Router();
const controller = require('./plant.controller');
const validate = require('../middleware/validate.middleware');
// FIX: all plant routes were completely unprotected — added auth middleware
const auth = require('../middleware/auth.middleware');

router.get('/', auth, controller.getPlants);
router.get('/:id', auth, controller.getPlantById);
router.post('/', auth, validate({
  plant_code: { required: true, maxLength: 20,  label: 'Plant code' },
  plant_name: { required: true, maxLength: 100, label: 'Plant name' }
}), controller.createPlant);
router.put('/:id', auth, controller.updatePlant);
router.patch('/:id/status', auth, controller.togglePlantStatus);
router.delete('/:id', auth, controller.deletePlant);

module.exports = router;
