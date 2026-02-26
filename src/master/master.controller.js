const {
  getMachineListService,
  getShiftListService,
  getMachinesByLineService
} = require("./master.service");

const getMachineList = async (req, res) => {
  try {
    const plant_id  = req.user.plant_id 

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
    const plant_id  = req.user.plant_id 

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

const getMachinesByLine = async (req, res) => {
  try {

    const { line_id } = req.query;

    const machines = await getMachinesByLineService(
      line_id,
      req.user.plant_id  
    );

    res.json({
      success: true,
      data: machines
    });

  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  getMachineList,
  getShiftList,
  getMachinesByLine
};