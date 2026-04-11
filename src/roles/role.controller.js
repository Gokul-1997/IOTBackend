const svc = require('./role.service');

exports.seedPages = async (req, res) => {
  try {
    res.json(await svc.seedPagePermissions());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const company_id = req.user.is_snt_super ? (req.body.company_id || null) : req.user.company_id;
    res.status(201).json(await svc.create({ ...req.body, company_id }));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    res.json(await svc.list({
      company_id:   req.user.company_id,
      is_snt_super: req.user.is_snt_super
    }));
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

exports.update = async (req, res) => {
  try {
    res.json(await svc.update(req.params.id, req.body));
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
    const company_id = req.user.is_snt_super ? null : req.user.company_id;
    await svc.assignPermissions(req.params.id, req.body.permission_ids, company_id);
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
