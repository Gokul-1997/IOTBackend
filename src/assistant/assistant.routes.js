/*
 * /api/assistant — the company assistant ("STM Mexa AI").
 *
 *   GET  /status     on for this person? suggestions, today's allowance
 *   POST /chat       { messages: [{role, content, sig?}], context? } → a signed reply
 *
 * How much a company may use it is S&T's alone (23 Oct 2026, the user: "only
 * the super admin — up or down — not the company side"):
 * GET/PUT /api/companies/:id/assistant (company.routes).
 *
 * Only where S&T gave the company "STM Mexa AI" in Manage Access, and only
 * for the roles the company admin gave it (page:assistant:view — an opt-in
 * page: a company with no grants does not have it; 23 Oct 2026, the user:
 * "super admin decides for that company, not all users"). What each person
 * may then ask about follows their role — a tool for a page they may not
 * open is never offered (assistant.tools). S&T, with no company of its own,
 * is not served. Questions are limited per minute (assistantLimiter) on top
 * of the daily ceilings the service takes them from.
 */
const router = require('express').Router();
const ctrl = require('./assistant.controller');
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const { assistantLimiter } = require('../middleware/rateLimit.middleware');

/** A person of a company (not S&T): the assistant answers about one company, theirs. */
const companyPerson = (req, res, next) => (req.user?.company_id
  ? next() : res.status(403).json({ status: 'error', code: 'NO_COMPANY', message: 'STM Mexa AI answers for a company account.' }));

const assistantAccess = access('page:assistant:view');

router.get('/status', auth, companyPerson, assistantAccess, ctrl.status);
router.post('/chat', auth, companyPerson, assistantAccess, assistantLimiter, ctrl.chat);

module.exports = router;
