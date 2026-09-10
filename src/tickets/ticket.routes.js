const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./ticket.controller');

router.get('/summary',      auth, ctrl.getSummary);
router.get('/',              auth, ctrl.getTickets);
router.get('/:id',           auth, ctrl.getTicketById);
router.post('/',             auth, ctrl.createTicket);
router.put('/:id',           auth, ctrl.updateTicket);
router.patch('/:id/status',  auth, ctrl.updateStatus);
router.patch('/:id/assign',  auth, ctrl.assignTicket);

module.exports = router;
