const svc = require('./report.service');
const excel = require('./excel.util');

// FIX: all handlers were missing try/catch — async errors caused unhandled rejections
exports.hourlyOeeExcel = async (req, res, next) => {
  try {
    const data = await svc.hourlyOee(req.user.plant_id, req.query.date);
    const file = excel.createExcel('Hourly OEE', data);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename=hourly_oee_${req.query.date}.xlsx`
    );
    res.send(file);
  } catch (err) {
    next(err);
  }
};

exports.shiftOeeExcel = async (req, res, next) => {
  try {
    const data = await svc.shiftOee(req.user.plant_id, req.query.date);
    const file = excel.createExcel('Shift OEE', data);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename=shift_oee_${req.query.date}.xlsx`
    );
    res.send(file);
  } catch (err) {
    next(err);
  }
};

exports.productionExcel = async (req, res, next) => {
  try {
    const data = await svc.production(req.user.plant_id, req.query.date);
    const file = excel.createExcel('Production', data);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename=production_${req.query.date}.xlsx`
    );
    res.send(file);
  } catch (err) {
    next(err);
  }
};
