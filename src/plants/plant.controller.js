const service = require('./plant.service');

exports.getPlants = async (req, res) => {
  const data = await service.getPlants(req.query);
  res.json(data);
};

exports.getPlantById = async (req, res) => {
  const plant = await service.getPlantById(req.params.id);
  res.json(plant);
};

exports.createPlant = async (req, res) => {
  const plant = await service.createPlant(req.body);
  res.status(201).json({ message: 'Plant created', plant });
};

exports.updatePlant = async (req, res) => {
  const plant = await service.updatePlant(req.params.id, req.body);
  res.json({ message: 'Plant updated', plant });
};

exports.togglePlantStatus = async (req, res) => {
  await service.togglePlantStatus(req.params.id, req.body.is_active);
  res.json({ message: 'Status updated' });
};

exports.deletePlant = async (req, res) => {
  await service.deletePlant(req.params.id);
  res.json({ message: 'Plant deleted' });
};
