const service = require('./user.service');

exports.create = async (req, res) => {
  try {
    res.json(await service.create(req.body, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    res.json(await service.list(req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    res.json(await service.getById(req.params.id, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    res.json(await service.update(req.params.id, req.user, req.body));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await service.remove(req.params.id, req.user);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
