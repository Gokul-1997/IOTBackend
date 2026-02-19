const service = require('./machine.service');

exports.createMachine = async (req, res) => {
  try {
    const data = await service.createMachine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.getMachines = async (req, res) => {
  try {
    const result = await service.getMachines(req);
    res.json({
      status: 'success',
      data: result.data,
      total: result.total
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};

exports.toggleMachineStatus = async (req, res) => {
  try {
    await service.toggleMachineStatus(req);
    res.json({ status: 'success', message: 'Status updated' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.regenerateApiKey = async (req, res) => {
  try {
    const apiKey = await service.regenerateApiKey(req);
    res.json({ status: 'success', api_key: apiKey });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.deleteMachine = async (req, res) => {
  try {
    await service.deleteMachine(req);
    res.json({ status: 'success', message: 'Machine deleted successfully' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};
