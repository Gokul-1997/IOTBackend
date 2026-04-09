const svc = require('./role.service');

exports.seedPages = async (req, res) => {
  try {
    res.json(await svc.seedPagePermissions());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPages = async (req, res) => {
  try {
    res.json(await svc.listPagePermissions());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    res.json(await svc.create(req.body));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    res.json(await svc.list());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    res.json(await svc.getById(req.params.id));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPermissions = async (req, res) => {
  try {
    res.json(await svc.listPermissions());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.assignPermissions = async (req, res) => {
  try {
    await svc.assignPermissions(req.params.id, req.body.permission_ids);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await svc.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.assign = async (req, res) => {
  try {
    await svc.assign(req.params.id, req.body.role_ids);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
