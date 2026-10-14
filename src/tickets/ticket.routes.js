const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const ctrl = require('./ticket.controller');
const scoped = require('../middleware/plant-scope.middleware')({ assignee: true });
const scopedTicket = require('../middleware/plant-scope.middleware')({ resource: 'ticket', assignee: true });

router.get('/summary',      auth, access('page:maintenance:view'), scoped, ctrl.getSummary);
router.get('/',              auth, access('page:maintenance:view'), scoped, ctrl.getTickets);
// before '/:id', which would otherwise take "assignees" as a ticket id
router.get('/assignees',     auth, access('page:maintenance:view'), scoped, ctrl.getAssignees);
router.get('/:id',           auth, access('page:maintenance:view'), scopedTicket, ctrl.getTicketById);
router.post('/',             auth, access('page:maintenance:create'), scoped, ctrl.createTicket);
router.put('/:id',           auth, access('page:maintenance:edit'), scopedTicket, ctrl.updateTicket);
router.patch('/:id/status',  auth, access('page:maintenance:edit'), scopedTicket, ctrl.updateStatus);
router.patch('/:id/assign',  auth, access('page:maintenance:edit'), scopedTicket, ctrl.assignTicket);

module.exports = router;
