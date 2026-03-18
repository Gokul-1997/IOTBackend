const service = require('./job.service');

exports.startJob = async (req, res) => {
  try {

    const result = await service.startJob(req);

    res.json({
      status: "success",
      data: result
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message
    });

  }
};


exports.stopJob = async (req,res)=>{

  try{

    const { machine_id, job_end } = req.body;

    await service.stopJob(machine_id, job_end);

    return res.json({
      status:"success"
    });

  }catch(err){

    console.error(err);

    return res.status(500).json({
      status:"error",
      message:err.message
    });

  }

};


exports.getCurrentJobs = async (req, res) => {

  try {

    const plantId = req.user.plant_id;

    const result = await service.getCurrentJobs(plantId);

    res.json({
      status: "success",
      data: result
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message
    });

  }

};