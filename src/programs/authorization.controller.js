const service = require('./authorization.service');

/**
 * Ask for a one-time code. The response names the supervisor and their
 * masked contact so the requester knows who to go and find — it never
 * carries the code itself.
 */
exports.requestAuthorization = async (req, res) => {
  try {
    const data = await service.requestAuthorization({
      machine_id:    req.body?.machine_id,
      program_ids:   req.body?.program_ids || [],
      supervisor_id: req.body?.supervisor_id,
      channel:       req.body?.channel || 'EMAIL',
      user:          req.user
    });
    res.json({ status: 'success', data, message: 'Authorisation code sent' });
  } catch (e) {
    // `code` drives the UI branch (assign a supervisor / pick one /
    // retry), and `supervisors` is present only on SUPERVISOR_REQUIRED.
    res.status(e.status || 400).json({
      status: 'error',
      code: e.code,
      message: e.message,
      supervisors: e.supervisors
    });
  }
};

/** Who may authorise transfers to this machine. */
exports.getSupervisors = async (req, res) => {
  try {
    const data = await service.listSupervisors(req.params.machineId, req.user.company_id);
    res.json({ status: 'success', data, total: data.length });
  } catch (e) {
    res.status(e.status || 400).json({ status: 'error', code: e.code, message: e.message });
  }
};
