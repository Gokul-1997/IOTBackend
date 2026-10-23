/*
 * /api/assistant — the report assistant ("STM Mexa AI").
 * Errors go to the error middleware: a refusal keeps its sentence, a server
 * fault is logged under a reference.
 */
const { createAssistant } = require('./assistant.service');
const allowance = require('./assistant.allowance');
const readConfig = require('./assistant.config');

/** The settings, and the company's own daily total the platform holds it to (the admin sees it, cannot change it). */
const withCompanyMax = settings => ({ ...settings, company_daily_max: readConfig().companyDailyMax });

const assistant = createAssistant();

exports.status = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'success', data: await assistant.status(req.user) });
  } catch (err) { next(err); }
};

exports.chat = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');          // an answer is this person's, never a shared cache's
    res.json({ status: 'success', data: await assistant.chat(req.user, req.body || {}) });
  } catch (err) { next(err); }
};

exports.getSettings = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'success', data: withCompanyMax(await allowance.settingsOf(req.user)) });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try { res.json({ status: 'success', data: withCompanyMax(await allowance.updateSettings(req.user, req.body || {})) }); }
  catch (err) { next(err); }
};

exports._assistant = assistant;
