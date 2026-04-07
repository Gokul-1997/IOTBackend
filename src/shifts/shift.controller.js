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
    const data = await service.updateShift(
      req.params.id,
      req.body,
      req.user.plant_id
    );

    res.json({
      success: true,
      data
    });

  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    await service.deleteShift(req.params.id, req.user.plant_id);
    res.json({ success: true, message: 'Shift deleted' });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
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
