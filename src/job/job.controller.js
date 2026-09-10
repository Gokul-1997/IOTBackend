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

    const { machine_id } = req.body;

    await service.stopJob(machine_id, req.user.company_id);

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

    const companyId = req.user.company_id;

    const result = await service.getCurrentJobs(companyId, {
      page:  req.query.page,
      limit: req.query.limit
    });

    // `data` stays an array so existing clients keep working; the paging
    // fields sit alongside it for anyone who asks for page/limit.
    res.json({
      status: "success",
      data:       result.data,
      total:      result.total,
      page:       result.page,
      limit:      result.limit,
      totalPages: result.totalPages
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message
    });

  }

};

exports.getAvailableMachines = async (req, res) => {
  try {
    const result = await service.getAvailableMachines(req.user.company_id);
    res.json({ status: 'success', data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};

exports.getJobHistory = async (req, res) => {

  try {

    const companyId = req.user.company_id;

    const result = await service.getJobHistory(companyId, {
      page:  req.query.page,
      limit: req.query.limit
    });

    res.json({
      status: "success",
      data:       result.data,
      total:      result.total,
      page:       result.page,
      limit:      result.limit,
      totalPages: result.totalPages
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message
    });

  }

};