const {
  getMachineListService,
  getShiftListService
} = require("./master.service");

const getMachineList = async (req, res) => {
  try {
    const { plant_id } = req.query;

    const machines = await getMachineListService(plant_id);

    res.json({
      success: true,
      data: machines
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching machines"
    });
  }
};

const getShiftList = async (req, res) => {
  try {
    const { plant_id } = req.query;

    const shifts = await getShiftListService(plant_id);

    res.json({
      success: true,
      data: shifts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching shifts"
    });
  }
};

module.exports = {
  getMachineList,
  getShiftList
};