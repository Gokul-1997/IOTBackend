const svc = require('./role.service');

exports.create = async (req, res) =>
  res.json(await svc.create(req.body));

exports.assign = async (req, res) => {
  await svc.assign(req.params.id, req.body.role_ids);
  res.json({ success: true });
};
