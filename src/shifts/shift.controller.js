const service = require('./shift.service');

exports.getShifts = async (req, res) => {
  try {
    const data = await service.getShifts(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};

exports.createShift = async (req, res) => {
  try {
    await service.createShift(req);
    res.json({ status: 'success', message: 'Shift created' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.updateShift = async (req, res) => {
  try {
    await service.updateShift(req);
    res.json({ status: 'success', message: 'Shift updated' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};


exports.toggleShift = async (req, res) => {
  try {
    await service.toggleShift(req);
    res.json({ status: 'success', message: 'Status updated' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};
