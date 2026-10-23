const sendError = require('../utils/controller-error');
const service = require('./shift.service');

exports.getShifts = async (req, res) => {
  try {
    const data = await service.getShifts(req);
    res.json({ status: 'success', data });
  } catch (e) {
    return sendError(e, req, res, { status: 'error' });
  }
};

exports.createShift = async (req, res) => {
  try {
    await service.createShift(req);
    res.json({ status: 'success', message: 'Shift created' });
  } catch (e) {
    return sendError(e, req, res, { status: 'error' });
  }
};

exports.updateShift = async (req, res) => {
  try {
    const data = await service.updateShift(
      req.params.id,
      req.body,
      req.user.company_id
    );

    res.json({
      success: true,
      data
    });

  } catch (err) {
    return sendError(err, req, res, { success: false });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    await service.deleteShift(req.params.id, req.user.company_id);
    res.json({ success: true, message: 'Shift deleted' });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.toggleShift = async (req, res) => {
  try {
    await service.toggleShift(req);
    res.json({ status: 'success', message: 'Status updated' });
  } catch (e) {
    return sendError(e, req, res, { status: 'error' });
  }
};

/* Break windows: a clean status for every refusal — 400 bad input,
   404 not this company's shift, 503 before migration 028. */
exports.getBreaks = async (req, res) => {
  try {
    res.json({ status: 'success', data: await service.getBreaks(req.params.id, req.user.company_id) });
  } catch (e) {
    return sendError(e, req, res, { status: 'error' });
  }
};

exports.saveBreaks = async (req, res) => {
  try {
    const data = await service.saveBreaks(req.params.id, req.user.company_id, req.body?.breaks);
    res.json({ status: 'success', data });
  } catch (e) {
    return sendError(e, req, res, { status: 'error' });
  }
};
