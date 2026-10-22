/*
 * /api/assistant — the report assistant ("STM Mexa AI").
 *
 *   GET  /status     on for this person? suggestions, today's allowance
 *   POST /chat       { messages: [{role, content}], context? } → a reply
 *   GET  /settings   the company admin: daily allowance, timezone
 *   PUT  /settings   { daily_limit: 0–1000, timezone? }
 *
 * For people with report access (Reports or OEE Records), as the spec says.
 */
const router = require('express').Router();
const ctrl = require('./assistant.controller');
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const role = require('../middleware/role.middleware');

const reportAccess = access.any('page:reports:view', 'page:oee-reports:view');
const companyAdmin = role(['COMPANY_ADMIN', 'ADMIN']);

router.get('/status', auth, reportAccess, ctrl.status);
router.post('/chat', auth, reportAccess, ctrl.chat);
router.get('/settings', auth, companyAdmin, ctrl.getSettings);
router.put('/settings', auth, companyAdmin, ctrl.updateSettings);

module.exports = router;
