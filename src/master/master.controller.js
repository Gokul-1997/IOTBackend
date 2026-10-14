const { effectivePlantId } = require('../lib/plant-scope');
const {
  getMachineListService,
  getShiftListService,
  getMachinesByLineService
} = require("./master.service");

const getMachineList = async (req, res, next) => {
  try {
    const machines = await getMachineListService(effectivePlantId(req.user), req.user.company_id);

    res.json({
      success: true,
      data: machines
    });
  } catch (error) {
    next(error);
  }
};

const getShiftList = async (req, res, next) => {
  try {
    const shifts = await getShiftListService(effectivePlantId(req.user), req.user.company_id);

    res.json({
      success: true,
      data: shifts
    });
  } catch (error) {
    next(error);
  }
};

const getMachinesByLine = async (req, res, next) => {
  try {

    const { line_id } = req.query;

    const machines = await getMachinesByLineService(
      line_id,
      effectivePlantId(req.user),
      req.user.company_id
    );

    res.json({
      success: true,
      data: machines
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMachineList,
  getShiftList,
  getMachinesByLine
};

module.exports.getPlantList = async (req, res, next) => {
  try { res.json({ success: true, data: await require('./master.service').getPlantListService(effectivePlantId(req.user), req.user.company_id) }); }
  catch (err) { next(err); }
};
