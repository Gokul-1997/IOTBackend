const svc = require('./assignment.service');

exports.operatorMachine = async (req, res) => {
  res.json(await svc.assignOperatorMachine(req.body, req.user.plant_id));
};

exports.operatorShift = async (req, res) => {
  res.json(await svc.assignOperatorShift(req.body, req.user.plant_id));
};
