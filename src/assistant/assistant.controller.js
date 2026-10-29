/*
 * /api/assistant — the report assistant ("Mexa AI") — and, for S&T,
 * /api/companies/:id/assistant: how much one company may use it.
 * Errors go to the error middleware: a refusal keeps its sentence, a server
 * fault is logged under a reference.
 */
const { createAssistant } = require('./assistant.service');
const allowance = require('./assistant.allowance');

const assistant = createAssistant();

/** The company in the address, as a positive whole number. */
function companyIdOf(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Company not found.'), { status: 404, code: 'COMPANY_NOT_FOUND' });
  return id;
}

exports.status = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'success', data: await assistant.status(req.user) });
  } catch (err) { next(err); }
};

exports.chat = async (req, res, next) => {
  const controller = new AbortController();
  const stop = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', stop);
  res.once('close', stop);
  try {
    res.setHeader('Cache-Control', 'no-store');
    const data = await assistant.chat(req.user, req.body || {}, { signal: controller.signal });
    if (!res.destroyed) res.json({ status: 'success', data });
  } catch (err) { if (!res.destroyed) next(err); }
  finally { req.removeListener('aborted', stop); res.removeListener('close', stop); }
};

/** A person flags an answer. Only the trimmed, bounded fields reach the audit row
    (audited() records req.body), where S&T and the company admin read it. */
exports.report = (req, res) => {
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const answer = text(req.body?.answer, 4000);
  if (!answer) return res.status(400).json({ status: 'error', code: 'NO_ANSWER', message: 'Which answer? Nothing was reported.' });
  req.body = { answer, question: text(req.body?.question, 500) || null, reason: text(req.body?.reason, 300) || null };
  res.status(201).json({ status: 'success', message: 'Reported. Thank you.' });
};

/** S&T: one company's figures, its timezone, and its use today and this month. */
exports.getCompanySettings = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'success', data: await allowance.companySettings(companyIdOf(req)) });
  } catch (err) { next(err); }
};

/** S&T: raise or lower one company's figures (audited). */
exports.updateCompanySettings = async (req, res, next) => {
  try { res.json({ status: 'success', data: await allowance.updateCompanySettings(companyIdOf(req), req.body || {}, req.user) }); }
  catch (err) { next(err); }
};

exports._assistant = assistant;
