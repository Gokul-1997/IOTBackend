const express = require('express');
const router = express.Router();
const controller = require('./plant.controller');

router.get('/', controller.getPlants);
router.get('/:id', controller.getPlantById);
router.post('/', controller.createPlant);
router.put('/:id', controller.updatePlant);
router.patch('/:id/status', controller.togglePlantStatus);
router.delete('/:id', controller.deletePlant);

module.exports = router;
