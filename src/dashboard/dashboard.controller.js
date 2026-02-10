const svc = require('./dashboard.service');

exports.live = async (req, res) => {
  res.json(
    await svc.liveMachines({
      user_id: req.user.id,
      plant_id: req.user.plant_id,
      role: req.user.role
    })
  );
};


exports.hourlyOee = async (req, res) => {
  const { machine_id, date } = req.query;
  res.json(
    await svc.hourlyOee(req.user.plant_id, machine_id, date)
  );
};

exports.shiftOee = async (req, res) => {
  res.json(
    await svc.shiftOee(req.user.plant_id, req.query.date)
  );
};

exports.operatorLive = async (req, res) => {
  res.json(
    await svc.operatorLive(req.user.plant_id)
  );
};
