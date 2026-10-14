const service = require('./line.service');

exports.createLine = async (req, res, next) => {
  try {
    const data = await service.createLine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    next(e);
  }
};

exports.getLines = async (req, res, next) => {
  try {
    const data = await service.getLines(req);
    res.json({ status: 'success', data });
  } catch (e) {
    next(e);
  }
};

exports.updateLine = async (req, res, next) => {
  try {
    const data = await service.updateLine(req);
    res.json({ status: 'success', data });
  } catch (e) {
    next(e);
  }
};

exports.deleteLine = async (req, res, next) => {
  try {
    await service.deleteLine(req);
    res.json({ status: 'success', message: 'Line deleted successfully' });
  } catch (e) {
    next(e);
  }
};