const service = require('./line.service');

exports.createLine = async (req, res) => {
  try {
    const data = await service.createLine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.getLines = async (req, res) => {
  try {
    const data = await service.getLines(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};

exports.updateLine = async (req, res) => {
  try {
    const data = await service.updateLine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.deleteLine = async (req, res) => {
  try {
    await service.deleteLine(req);
    res.json({ status: 'success', message: 'Line deleted successfully' });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};