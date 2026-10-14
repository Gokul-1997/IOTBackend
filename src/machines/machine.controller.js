const service = require('./machine.service');

exports.createMachine = async (req, res, next) => {
  try {
    const data = await service.createMachine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    next(e);
  }
};

exports.getMachines = async (req, res, next) => {
  try {
    const result = await service.getMachines(req);
    res.json({
      status: 'success',
      data: result.data,
      total: result.total
    });
  } catch (e) {
    next(e);
  }
};

exports.toggleMachineStatus = async (req, res, next) => {
  try {
    await service.toggleMachineStatus(req);
    res.json({ status: 'success', message: 'Status updated' });
  } catch (e) {
    next(e);
  }
};

exports.regenerateApiKey = async (req, res, next) => {
  try {
    const apiKey = await service.regenerateApiKey(req);
    res.json({ status: 'success', api_key: apiKey });
  } catch (e) {
    next(e);
  }
};

exports.deleteMachine = async (req, res, next) => {
  try {
    await service.deleteMachine(req);
    res.json({ status: 'success', message: 'Machine deleted successfully' });
  } catch (e) {
    next(e);
  }
};

exports.updateMachine = async (req, res, next) => {
  try {
    const data = await service.updateMachine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    next(e);
  }
};