const svc = require('./role.service');

exports.seedPages = async (req, res) => {
  try {
    res.json(await svc.seedPagePermissions());
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

/* Only the named fields are passed on. The whole body used to be spread
   into the service, which let a caller set is_system and company_id. */
exports.create = async (req, res) => {
  try {
    const { role_name, description, permission_ids } = req.body || {};
    res.status(201).json(await svc.create({ role_name, description, permission_ids }, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.copy = async (req, res) => {
  try {
    const { role_name, description } = req.body || {};
    res.status(201).json(await svc.copy(Number(req.params.id), { role_name, description }, req.user));
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
    res.json(await svc.getById(req.params.id, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { role_name, description } = req.body || {};
    res.json(await svc.update(req.params.id, { role_name, description }, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listPermissions = async (req, res) => {
  try {
    res.json(await svc.listPermissions({
      company_id: req.user.company_id,
      is_snt_super: req.user.is_snt_super
    }));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.assignPermissions = async (req, res) => {
  try {
    // role.service.js now derives company scoping from the actor itself —
    // and checks the role belongs to them — rather than trusting a
    // precomputed company_id with no ownership check behind it.
    await svc.assignPermissions(req.params.id, req.body.permission_ids, req.user);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await svc.remove(req.params.id, req.user);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.assign = async (req, res) => {
  try {
    await svc.assign(req.params.id, req.body.role_ids, req.user);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
