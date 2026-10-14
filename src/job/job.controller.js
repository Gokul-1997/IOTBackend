const service = require('./job.service');

exports.startJob = async (req, res, next) => {
  try {

    const result = await service.startJob(req);

    res.json({
      status: "success",
      data: result
    });

  } catch (err) {
    next(err);

  }
};


exports.stopJob = async (req,res,next)=>{

  try{

    const { machine_id } = req.body;

    await service.stopJob(machine_id, req.user.company_id, req.user.plant_id);

    return res.json({
      status:"success"
    });

  }catch(err){
    next(err);

  }

};


exports.getCurrentJobs = async (req, res, next) => {

  try {

    const companyId = req.user.company_id;

    const result = await service.getCurrentJobs(companyId, {
      page:  req.query.page,
      limit: req.query.limit,
      plant_id: req.user.plant_id
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
    next(err);

  }

};

exports.getAvailableMachines = async (req, res, next) => {
  try {
    const result = await service.getAvailableMachines(req.user.company_id, req.user.plant_id);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
};

exports.getJobHistory = async (req, res, next) => {

  try {

    const companyId = req.user.company_id;

    const result = await service.getJobHistory(companyId, {
      page:  req.query.page,
      limit: req.query.limit,
      plant_id: req.user.plant_id
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
    next(err);

  }

};