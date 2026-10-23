const sendError = require('../utils/controller-error');
const service = require('./user.service');

exports.create = async (req, res) => {
  try {
    res.json(await service.create(req.body, req.user));
  } catch (err) {
    return sendError(err, req, res);
  }
};

exports.list = async (req, res) => {
  try {
    res.json(await service.list(req.user));
  } catch (err) {
    return sendError(err, req, res);
  }
};

exports.getById = async (req, res) => {
  try {
    res.json(await service.getById(req.params.id, req.user));
  } catch (err) {
    return sendError(err, req, res);
  }
};

exports.update = async (req, res) => {
  try {
    res.json(await service.update(req.params.id, req.user, req.body));
  } catch (err) {
    return sendError(err, req, res);
  }
};

exports.remove = async (req, res) => {
  try {
    await service.remove(req.params.id, req.user);
    res.json({ success: true });
  } catch (err) {
    return sendError(err, req, res);
  }
};
