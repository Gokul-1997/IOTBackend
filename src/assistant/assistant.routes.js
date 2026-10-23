/*
 * /api/assistant — the company assistant ("STM Mexa AI").
 *
 *   GET  /status     on for this person? suggestions, today's allowance
 *   POST /chat       { messages: [{role, content, sig?}], context? } → a signed reply
 *   GET  /settings   the company admin: daily allowance, timezone
 *   PUT  /settings   { daily_limit: 0–ASSISTANT_DAILY_LIMIT_MAX, timezone? } (audited)
 *
 * For everyone in a company (22 Oct 2026, the user: "all company support");
 * what each person may ask about follows their role — a tool for a page they
 * may not open is never offered (assistant.tools). S&T, with no company of
 * its own, is not served. Questions are limited per minute
 * (assistantLimiter) on top of the daily ceilings the service takes them
 * from.
 */
const router = require('express').Router();
const ctrl = require('./assistant.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const audited = require('../middleware/audit.middleware');
const { assistantLimiter } = require('../middleware/rateLimit.middleware');

const companyAdmin = role(['COMPANY_ADMIN', 'ADMIN']);
/** A person of a company (not S&T): the assistant answers about one company, theirs. */
const companyPerson = (req, res, next) => (req.user?.company_id
  ? next() : res.status(403).json({ status: 'error', code: 'NO_COMPANY', message: 'STM Mexa AI answers for a company account.' }));

router.get('/status', auth, companyPerson, ctrl.status);
router.post('/chat', auth, companyPerson, assistantLimiter, ctrl.chat);
router.get('/settings', auth, companyAdmin, ctrl.getSettings);
router.put('/settings', auth, companyAdmin, audited('assistant_settings'), ctrl.updateSettings);

module.exports = router;
