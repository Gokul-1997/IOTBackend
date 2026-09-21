const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const ctrl = require('./ticket.controller');

router.get('/summary',      auth, ctrl.getSummary);
router.get('/',              auth, ctrl.getTickets);
// before '/:id', which would otherwise take "assignees" as a ticket id
router.get('/assignees',     auth, access('page:maintenance:view'), ctrl.getAssignees);
router.get('/:id',           auth, ctrl.getTicketById);
router.post('/',             auth, ctrl.createTicket);
router.put('/:id',           auth, ctrl.updateTicket);
router.patch('/:id/status',  auth, ctrl.updateStatus);
router.patch('/:id/assign',  auth, ctrl.assignTicket);

module.exports = router;
